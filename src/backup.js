import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createLogger } from "./log.js";

// ===========================================================================
// Off-site state backup (workstream R, item 3 — disk-failure protection).
//
// Lloyd's brain + all household state live as JSON under data/. A local disk /
// hardware failure would lose ALL of it (memory, decisions, conversations, tasks,
// reminders, watch list, etc.) — the Azure inbound queue protects *messages* during
// an outage, but nothing protected this STATE. This snapshots data/ to Azure Blob on
// a slow cadence so a dead SSD costs at most one interval, not everything.
//
// Blob (not Table) because brain.json with embeddings is ~1.6MB — past Table's
// 64KB/property + 1MB/entity limits. Reuses the existing storage account. The model
// cache (data/models, ~87MB, re-downloadable) is excluded. Best-effort: a backup
// failure never disturbs the daemon. Restore with `npm run restore` (data/restore-backup.mjs).
// ===========================================================================

const log = createLogger("backup");

const CONN = () => process.env.BACKUP_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = process.env.BACKUP_CONTAINER || "cos-state-backup";
const PREFIX = process.env.BACKUP_PREFIX || "latest"; // overwritten each run -> newest wins
// data/models is the ~87MB embeddings cache (regenerable); never back it up. Add more
// dirs/globs here if other large regenerable artifacts land under data/.
const EXCLUDE_DIRS = new Set((process.env.BACKUP_EXCLUDE_DIRS || "models").split(",").map((s) => s.trim()).filter(Boolean));

/**
 * Filter a list of data/-relative paths to the ones worth backing up: *.json only,
 * and nothing under an excluded dir (the model cache). Pure (exported for tests).
 */
export function selectBackupFiles(relPaths, exclude = EXCLUDE_DIRS) {
  return (relPaths || []).filter((p) => {
    if (!p.endsWith(".json")) return false;
    const top = p.split("/")[0];
    return !(p.includes("/") && exclude.has(top));
  });
}

// Recursively list *.json paths under dir, relative to dir. Skips excluded top dirs
// up front so we never even walk the 87MB model cache.
async function walkJson(dir, base = dir) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (dir === base && EXCLUDE_DIRS.has(e.name)) continue; // skip data/models etc.
      out.push(...(await walkJson(full, base)));
    } else if (e.isFile() && e.name.endsWith(".json")) {
      out.push(relative(base, full));
    }
  }
  return out;
}

let _container; // memoized ContainerClient (null = unavailable)
async function container() {
  if (_container !== undefined) return _container;
  const cs = CONN();
  if (!cs) { _container = null; return null; }
  try {
    const { BlobServiceClient } = await import("@azure/storage-blob");
    const svc = BlobServiceClient.fromConnectionString(cs);
    const c = svc.getContainerClient(CONTAINER);
    await c.createIfNotExists();
    _container = c;
  } catch (err) {
    log.warn("backup container unavailable (non-fatal)", { reason: String(err?.message || err) });
    _container = null;
  }
  return _container;
}

/**
 * Snapshot data/ to Blob under PREFIX/ (overwrite), plus a manifest with the file
 * list + timestamp. BEST-EFFORT: never throws. Returns {ok, count, bytes, skipped}.
 */
export async function backupState({ dir = process.env.BACKUP_DIR || "./data", now = new Date() } = {}) {
  try {
    const c = await container();
    if (!c) return { ok: false, count: 0, bytes: 0, reason: "no storage configured" };
    const files = selectBackupFiles(await walkJson(dir));
    let bytes = 0, count = 0;
    for (const rel of files) {
      try {
        const buf = await readFile(join(dir, rel));
        const blob = c.getBlockBlobClient(`${PREFIX}/${rel}`);
        await blob.uploadData(buf, { blobHTTPHeaders: { blobContentType: "application/json" } });
        bytes += buf.length; count += 1;
      } catch (err) {
        log.warn("backup file failed", { file: rel, reason: String(err?.message || err) });
      }
    }
    const manifest = Buffer.from(JSON.stringify({ at: now.toISOString(), files, count, bytes }, null, 2));
    try { await c.getBlockBlobClient(`${PREFIX}/_manifest.json`).uploadData(manifest, { blobHTTPHeaders: { blobContentType: "application/json" } }); } catch { /* manifest best-effort */ }
    log.info("state backup complete", { count, bytes, container: CONTAINER, prefix: PREFIX });
    return { ok: true, count, bytes };
  } catch (err) {
    log.warn("state backup failed (non-fatal)", { reason: String(err?.message || err) });
    return { ok: false, count: 0, bytes: 0, reason: String(err?.message || err) };
  }
}
