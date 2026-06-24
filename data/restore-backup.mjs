// Restore Lloyd's state from the off-site Azure Blob backup (workstream R).
// Use after a disk/hardware failure, on a fresh Mac: download the latest snapshot of
// data/*.json from Blob back into the local data/ dir. Run: `npm run restore`.
//
// Reads the same env as the daemon (BACKUP_CONNECTION_STRING || AZURE_STORAGE_CONNECTION_STRING,
// BACKUP_CONTAINER, BACKUP_PREFIX). Pass --dry to list without writing. Does NOT
// touch data/models (the regenerable embeddings cache was never backed up).

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BlobServiceClient } from "@azure/storage-blob";

const CONN = process.env.BACKUP_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = process.env.BACKUP_CONTAINER || "cos-state-backup";
const PREFIX = process.env.BACKUP_PREFIX || "latest";
const DIR = process.env.BACKUP_DIR || "./data";
const DRY = process.argv.includes("--dry");

if (!CONN) {
  console.error("No BACKUP_CONNECTION_STRING / AZURE_STORAGE_CONNECTION_STRING set.");
  process.exit(1);
}

const svc = BlobServiceClient.fromConnectionString(CONN);
const container = svc.getContainerClient(CONTAINER);

let restored = 0;
let bytes = 0;
for await (const b of container.listBlobsFlat({ prefix: `${PREFIX}/` })) {
  const rel = b.name.slice(PREFIX.length + 1); // strip "latest/"
  if (rel === "_manifest.json") continue; // metadata, not state
  const dest = join(DIR, rel);
  if (DRY) {
    console.log(`would restore ${rel} (${b.properties.contentLength} B)`);
    continue;
  }
  const dl = await container.getBlockBlobClient(b.name).downloadToBuffer();
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, dl);
  restored += 1;
  bytes += dl.length;
  console.log(`restored ${rel} (${dl.length} B)`);
}

console.log(DRY ? "(dry run, nothing written)" : `Restored ${restored} file(s), ${bytes} bytes from ${CONTAINER}/${PREFIX}/ -> ${DIR}`);
