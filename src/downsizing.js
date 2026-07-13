// Downsizing program (one-off move effort, ~two-week window). A local project
// store + lifecycle for selling household items across Craigslist, Facebook
// Marketplace, and Nextdoor. Managed like resale (Shey), but scoped to the move:
// each item carries its photos, a per-platform listing (title/description/price/
// category), and a status that walks draft -> listed -> pending -> sold -> pulled.
//
// This module is PURE state + file I/O (no browser, no model) so it is fully
// testable offline. The browser posting/pull seam lives in listings.js; the
// content drafting lives in the orchestrator tool (which can lean on Shey). Mark
// an item sold here and it tells the caller which OTHER platforms are still live
// and therefore need pulling (the "auto-pull everywhere" behaviour, gated).

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const STORE_PATH = () => process.env.DOWNSIZING_PATH || "./data/downsizing.json";
const PHOTO_ROOT = () => process.env.DOWNSIZING_PHOTO_DIR || "./data/downsizing-photos";

export const PLATFORMS = ["craigslist", "facebook", "nextdoor"];
const ACTIVE_ON_PLATFORM = new Set(["listed", "pending"]); // still publicly visible

const EXT_BY_TYPE = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heic",
};

async function load() {
  try {
    const d = JSON.parse(await readFile(STORE_PATH(), "utf8"));
    return Array.isArray(d.items) ? d : { items: [] };
  } catch {
    return { items: [] };
  }
}

async function save(db) {
  await mkdir(dirname(STORE_PATH()), { recursive: true });
  await writeFile(STORE_PATH(), JSON.stringify(db, null, 2));
}

function newId() {
  return "ds_" + randomBytes(3).toString("hex");
}

function blankPlatforms() {
  const p = {};
  for (const name of PLATFORMS) p[name] = { status: "draft", url: null, postedAt: null };
  return p;
}

/** Decode inbound photos (Anthropic image blocks {source:{data,media_type}} OR
 *  {bytes, contentType}) to files under the item's folder. Returns relative paths. */
export async function savePhotos(id, images = [], now = Date.now()) {
  const items = Array.isArray(images) ? images : [];
  if (!items.length) return [];
  const dir = join(PHOTO_ROOT(), id);
  await mkdir(dir, { recursive: true });
  const paths = [];
  let n = 0;
  for (const img of items) {
    let bytes, type;
    if (img?.source?.data) {
      bytes = Buffer.from(img.source.data, "base64");
      type = img.source.media_type;
    } else if (img?.bytes) {
      bytes = Buffer.isBuffer(img.bytes) ? img.bytes : Buffer.from(img.bytes);
      type = img.contentType || img.media_type;
    } else {
      continue;
    }
    const ext = EXT_BY_TYPE[String(type || "").toLowerCase()] || "jpg";
    const rel = join(dir, `${now}-${++n}.${ext}`);
    await writeFile(rel, bytes);
    paths.push(rel);
  }
  return paths;
}

/** Create an item. `photos` may be already-saved paths; pass `images` (turn
 *  attachments) to have them saved to disk automatically. */
export async function addItem(
  { title, description = "", category = null, condition = null, priceAsk = null,
    dimensions = null, notes = null, photos = [], platforms = PLATFORMS } = {},
  { images = [], now = Date.now() } = {}
) {
  if (!title || !String(title).trim()) throw new Error("title is required");
  const db = await load();
  const id = newId();
  const savedPhotos = images.length ? await savePhotos(id, images, now) : [];
  const wanted = new Set((platforms || PLATFORMS).filter((p) => PLATFORMS.includes(p)));
  const platformState = blankPlatforms();
  // Only enable the platforms the caller asked for; others stay "n/a".
  for (const name of PLATFORMS) if (!wanted.has(name)) platformState[name].status = "n/a";
  const item = {
    id,
    title: String(title).trim(),
    description: String(description || ""),
    category, condition, priceAsk, dimensions, notes,
    photos: [...(photos || []), ...savedPhotos],
    platforms: platformState,
    status: "draft",
    soldOn: null, soldPrice: null, soldAt: null,
    createdAt: now, updatedAt: now,
  };
  db.items.push(item);
  await save(db);
  return item;
}

function match(item, ref) {
  const r = String(ref || "").toLowerCase().trim();
  return item.id === ref || item.id.toLowerCase() === r ||
    item.title.toLowerCase() === r || item.title.toLowerCase().includes(r);
}

export async function getItem(ref) {
  const db = await load();
  return db.items.find((i) => match(i, ref)) || null;
}

export async function listItems({ status = null, includeSold = true, includePulled = true } = {}) {
  const db = await load();
  return db.items.filter((i) => {
    if (status && i.status !== status) return false;
    if (!includeSold && i.status === "sold") return false;
    if (!includePulled && i.status === "pulled") return false;
    return true;
  });
}

export async function updateItem(ref, patch = {}, now = Date.now()) {
  const db = await load();
  const item = db.items.find((i) => match(i, ref));
  if (!item) throw new Error(`no downsizing item matching "${ref}"`);
  const safe = { ...patch };
  delete safe.id; delete safe.platforms; delete safe.createdAt; // set via dedicated fns
  Object.assign(item, safe, { updatedAt: now });
  await save(db);
  return item;
}

/** Record the result of posting (or pulling) on one platform. */
export async function setPlatformStatus(ref, platform, { status, url = undefined } = {}, now = Date.now()) {
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown platform "${platform}"`);
  const db = await load();
  const item = db.items.find((i) => match(i, ref));
  if (!item) throw new Error(`no downsizing item matching "${ref}"`);
  const p = item.platforms[platform];
  if (status) p.status = status;
  if (url !== undefined) p.url = url;
  if (status === "listed") p.postedAt = now;
  // Overall status rolls up: any platform listed/pending -> "active" (unless sold).
  if (item.status !== "sold") {
    item.status = PLATFORMS.some((n) => ACTIVE_ON_PLATFORM.has(item.platforms[n].status))
      ? "active" : "draft";
  }
  item.updatedAt = now;
  await save(db);
  return item;
}

/** Mark an item SOLD. Returns { item, toPull } where toPull is the list of OTHER
 *  platforms still publicly live and therefore needing take-down (auto-pull). */
export async function markSold(ref, { platform = null, price = null } = {}, now = Date.now()) {
  const db = await load();
  const item = db.items.find((i) => match(i, ref));
  if (!item) throw new Error(`no downsizing item matching "${ref}"`);
  item.status = "sold";
  item.soldOn = platform;
  item.soldPrice = price;
  item.soldAt = now;
  item.updatedAt = now;
  const toPull = PLATFORMS.filter(
    (n) => n !== platform && ACTIVE_ON_PLATFORM.has(item.platforms[n].status)
  );
  await save(db);
  return { item, toPull };
}

/** Mark a platform listing pulled (after a successful take-down). When every
 *  active platform is down, a sold item settles to "pulled". */
export async function markPulled(ref, platform, now = Date.now()) {
  const item = await setPlatformStatus(ref, platform, { status: "pulled", url: null }, now);
  if (item.status === "sold" && !PLATFORMS.some((n) => ACTIVE_ON_PLATFORM.has(item.platforms[n].status))) {
    const db = await load();
    const it = db.items.find((i) => i.id === item.id);
    it.status = "pulled";
    it.updatedAt = now;
    await save(db);
    return it;
  }
  return item;
}

export async function removeItem(ref, { deletePhotos = true } = {}) {
  const db = await load();
  const idx = db.items.findIndex((i) => match(i, ref));
  if (idx < 0) return false;
  const [item] = db.items.splice(idx, 1);
  await save(db);
  if (deletePhotos) await rm(join(PHOTO_ROOT(), item.id), { recursive: true, force: true }).catch(() => {});
  return true;
}

// ---- formatting / rollups (for tools + digest) --------------------------------

const PLABEL = { craigslist: "CL", facebook: "FB", nextdoor: "ND" };

export function formatItem(item) {
  const price = item.priceAsk != null ? `$${item.priceAsk}` : "no price yet";
  const plat = PLATFORMS
    .filter((n) => item.platforms[n].status !== "n/a")
    .map((n) => `${PLABEL[n]}:${item.platforms[n].status}`)
    .join(" ");
  let line = `[${item.id}] ${item.title} (${price}) - ${item.status} | ${plat}`;
  if (item.status === "sold") {
    line += ` | sold${item.soldOn ? ` on ${item.soldOn}` : ""}${item.soldPrice != null ? ` for $${item.soldPrice}` : ""}`;
  }
  if (item.photos.length) line += ` | ${item.photos.length} photo(s)`;
  return line;
}

export function formatItems(items) {
  if (!items.length) return "No downsizing items yet.";
  return items.map(formatItem).join("\n");
}

/** Compact counts for the digest move-countdown line. */
export async function summary() {
  const items = await listItems();
  const c = { total: items.length, draft: 0, active: 0, sold: 0, pulled: 0, soldValue: 0 };
  for (const i of items) {
    c[i.status] = (c[i.status] || 0) + 1;
    if (i.status === "sold" && typeof i.soldPrice === "number") c.soldValue += i.soldPrice;
  }
  return c;
}
