import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { readPage } from "./channels/browser.js";

// ===========================================================================
// Price watch for specific items. "Watch this item" records a listing URL and an
// optional target price; on a schedule we re-read the page, extract the current
// price, and flag a DROP or a hit on the target. Reading the listing page is the
// LOCAL browser (readPage on Lloyd's Mac) on resale's behalf. Price extraction
// from page text is a heuristic and may need per-site tuning, but the track /
// compare / flag mechanism is solid.
// ===========================================================================

const STORE_PATH = () => process.env.WATCH_PATH || "./data/watched-items.json";

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

/** First plausible dollar amount in page text (usually the listing price). Pure. */
export function extractPrice(text) {
  const matches = String(text || "").match(/\$\s?([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?|[0-9]+(?:\.[0-9]{2})?)/g) || [];
  for (const m of matches) {
    const n = Number(m.replace(/[$,\s]/g, ""));
    if (n > 0 && n < 1_000_000) return n;
  }
  return null;
}

/**
 * Pick the best price from a readPage result, across sites. Prefer STRUCTURED data
 * (schema.org JSON-LD, then product/OG meta, then microdata) because it's the actual
 * listing price the site declares — the visible-text heuristic is the LAST resort
 * (it can catch a shipping fee or a "you save $X" promo). This is what makes the
 * watch work on TheRealReal, eBay, Poshmark, Vestiaire, 1stDibs, etc. without
 * per-site selectors. Pure; `page` is a readPage() result. Returns a number or null.
 */
export function pickPrice(page) {
  const s = (page && page.priceSignals) || {};
  for (const v of [s.jsonLd, s.meta, s.microdata]) {
    const n = Number(v);
    if (v != null && Number.isFinite(n) && n > 0) return n;
  }
  return extractPrice(page && page.text);
}

/** Compare a fresh price to what we last saw / the target. Pure. */
export function priceStatus(current, { lastPrice = null, targetPrice = null } = {}) {
  return {
    dropped: lastPrice != null && current != null && current < lastPrice,
    hitTarget: targetPrice != null && current != null && current <= targetPrice,
    delta: lastPrice != null && current != null ? current - lastPrice : null,
  };
}

/** Add an item to watch. Returns the entry. */
export async function watchItem({ url, label = null, targetPrice = null } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) throw new Error("a listing URL (http/https) is required");
  const db = await load();
  const existing = db.items.find((i) => i.url === url);
  if (existing) {
    if (label) existing.label = label;
    if (targetPrice != null) existing.targetPrice = Number(targetPrice);
    await save(db);
    return existing;
  }
  const entry = {
    id: randomUUID().slice(0, 8),
    url,
    label: label || url,
    targetPrice: targetPrice == null ? null : Number(targetPrice),
    lastPrice: null,
    history: [],
    createdAt: new Date().toISOString(),
  };
  db.items.push(entry);
  await save(db);
  return entry;
}

export async function listWatched() {
  return (await load()).items;
}

export async function unwatchItem(match) {
  const db = await load();
  const m = String(match || "").trim();
  const it = db.items.find((i) => i.id === m) || db.items.find((i) => i.url === m) || db.items.find((i) => i.id.startsWith(m) && m.length >= 4);
  if (!it) return null;
  db.items = db.items.filter((i) => i.id !== it.id);
  await save(db);
  return it;
}

/**
 * Re-check every watched item: read the page, extract the price, record it, and
 * return the ones that DROPPED or hit their target. `read` is injectable for tests.
 */
export async function checkWatched({ read = readPage, now = () => new Date().toISOString() } = {}) {
  const db = await load();
  const flagged = [];
  for (const it of db.items) {
    let current = null;
    try {
      const page = await read(it.url);
      current = pickPrice(page);
    } catch {
      continue; // a page that won't load this round is retried next slot
    }
    if (current == null) continue;
    const status = priceStatus(current, it);
    it.history.push({ price: current, at: now() });
    if (it.history.length > 50) it.history = it.history.slice(-50);
    if (status.dropped || status.hitTarget) {
      flagged.push({ label: it.label, url: it.url, current, lastPrice: it.lastPrice, targetPrice: it.targetPrice, ...status });
    }
    it.lastPrice = current;
  }
  await save(db);
  return flagged;
}

/** Human summary of flagged drops. */
export function formatWatchFlags(flagged) {
  if (!flagged || !flagged.length) return "";
  return flagged
    .map((f) => {
      const tag = f.hitTarget ? `hit your target ($${f.targetPrice})` : `dropped${f.delta != null ? ` $${Math.abs(f.delta).toFixed(2)}` : ""}`;
      return `- ${f.label}: now $${f.current} (${tag})\n  ${f.url}`;
    })
    .join("\n");
}
