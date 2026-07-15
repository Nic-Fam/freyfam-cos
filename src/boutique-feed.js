import { createHash } from "node:crypto";
import { createCollection } from "./stores/collection.js";
import { readListingFeed } from "./channels/browser.js";
import { matchesAnyHunt } from "./saved-searches.js";

// ===========================================================================
// Archive-boutique new-arrivals feed. Small curated vintage/archive shops (e.g.
// Allison's Archive, LAL Vintage) list pieces before a search engine indexes them,
// so a web-search saved-search can miss a fresh drop. These storefronts are PUBLIC
// (no login), so the local headless browser can read them directly — like the TRR
// First Look feed but for public shops, and safe to run autonomously on the daemon.
//
// Most are Shopify (/products/ links), so readListingFeed's default anchor works.
// Read-only; nothing acts or spends. Configure via BOUTIQUE_FEEDS (JSON array of
// {name, url, anchorPrefix?, fields?}); the default hunts the Dsquared2 feather top.
// SELECTOR CAVEAT: field selectors vary per shop, so we key on the product href
// (always present) and derive a name from the slug; add `fields` per boutique after
// a live capture if you want richer titles. Degrades to "no finds", never crashes.
// ===========================================================================

export const BOUTIQUES = (() => {
  try { const j = JSON.parse(process.env.BOUTIQUE_FEEDS || ""); if (Array.isArray(j) && j.length) return j; } catch { /* fall through */ }
  return [
    { name: "Allison's Archive", url: "https://allisonsarchive.shop/search?q=dsquared", anchorPrefix: "/products/" },
    { name: "LAL Vintage", url: "https://lalvintage.com/search?q=dsquared", anchorPrefix: "/products/" },
  ];
})();

const feedHits = () =>
  createCollection({ file: process.env.BOUTIQUE_FEED_HITS_PATH || "./data/boutique-feed-hits.json", partition: "boutiquefeedhit" });

// Listings the family explicitly rejected ("these aren't right"). Keyed by the
// CANONICAL href so a reply that quotes the alert (with or without tracking
// params) matches, and so a dismissed piece stays gone even if the seen-history
// is cleared or its handle later reappears in the grid.
const dismissedCol = () =>
  createCollection({ file: process.env.BOUTIQUE_DISMISSED_PATH || "./data/boutique-dismissed.json", partition: "boutiquedismissed" });

const hitId = (name, href) => createHash("sha1").update(`${name}|${href}`).digest("hex").slice(0, 12);

/** Derive a readable name from a /products/<handle> slug. Pure. */
export function slugToName(href) {
  const m = String(href || "").match(/\/products\/([^/?#]+)/);
  if (!m) return null;
  const n = m[1].replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  return n || null;
}

/**
 * Canonical product href — the STABLE identity of a listing, used for both dedup
 * and display. Shopify search anchors carry volatile query params
 * (`?_pos=1&_sid=<per-request>&_ss=r`): `_sid` changes every fetch and `_pos`
 * shifts as inventory reorders, so keying dedup on the raw href made the SAME item
 * hash differently each run and re-alert forever. We collapse to `/products/<handle>`
 * (a listing's true identity) and otherwise just drop the query/fragment. Pure.
 */
export function canonicalHref(href) {
  const s = String(href || "");
  if (/^https?:\/\//i.test(s)) {
    // Absolute: keep the origin, collapse to the product path, drop query/fragment.
    try {
      const u = new URL(s);
      const m = u.pathname.match(/\/products\/[^/?#]+/);
      return `${u.origin}${m ? m[0] : u.pathname}`;
    } catch { return s.split(/[?#]/)[0]; }
  }
  // Relative: collapse to /products/<handle>, else at least strip query/fragment.
  const m = s.match(/\/products\/[^/?#]+/);
  return m ? m[0] : s.split(/[?#]/)[0];
}

/** Normalize raw feed rows to {href, url, name}. Dedupes by CANONICAL href
 *  (query/fragment stripped) so tracking params can't defeat dedup. Pure. */
export function normalizeBoutiqueItems(items, base = "") {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    const rawHref = it && it.href;
    if (!rawHref) continue;
    const href = canonicalHref(rawHref);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const url = /^https?:\/\//i.test(href) ? href : `${String(base).replace(/\/$/, "")}${href}`;
    out.push({ href, url, name: (it.title || "").trim() || slugToName(href) });
  }
  return out;
}

/**
 * Record listings the family said aren't right, so they never surface again.
 * Accepts full URLs or /products/ hrefs (canonicalized before storing), dedupes,
 * and returns the hrefs newly dismissed. `col` injectable for tests.
 */
export async function dismissBoutiqueListings(urls, { col = dismissedCol() } = {}) {
  const list = Array.isArray(urls) ? urls : [urls];
  const have = new Set((await col.list()).map((d) => d.href));
  const added = [];
  for (const raw of list) {
    const href = canonicalHref(raw);
    if (!href || have.has(href)) continue;
    have.add(href);
    await col.add({ id: hitId("_dismissed", href), href, at: new Date().toISOString() });
    added.push(href);
  }
  return added;
}

/** All dismissed boutique hrefs (canonical). */
export async function listDismissedBoutique({ col = dismissedCol() } = {}) {
  return (await col.list()).map((d) => d.href);
}

/** Human summary of new boutique finds. Pure. */
export function formatBoutiqueFeed(results, { max = 10 } = {}) {
  const lines = [];
  for (const r of results || []) {
    if (!r.newItems || !r.newItems.length) continue;
    lines.push(`${r.name}:`);
    for (const i of r.newItems.slice(0, max)) lines.push(`- ${i.name || "New listing"}\n  ${i.url}`);
  }
  return lines.join("\n");
}

/**
 * Scan each boutique's storefront for NEW listings since the last run (deduped by
 * boutique+href). First run for a given boutique SEEDS SILENTLY (records all,
 * surfaces none) so it never dumps the whole shop.
 *
 * `hunts` hones the feed to the specific pieces the family is tracking: a new
 * listing only surfaces if it matches one of the saved searches. Every seen href is
 * still recorded (so a non-match never re-surfaces later either). With no hunts
 * configured the feed is unfiltered. `read` injectable for tests.
 * @returns {Promise<Array<{name, newItems, totalFound, seeded, error}>>}
 */
export async function runBoutiqueFeeds({ read = readListingFeed, now = () => new Date().toISOString(), boutiques = BOUTIQUES, hunts = [] } = {}) {
  const col = feedHits();
  const existing = await col.list();
  const known = new Set(existing.map((h) => h.id));
  const boutiquesSeen = new Set(existing.map((h) => h.name));
  // Listings the family rejected via email ("not right"): never surface these,
  // regardless of seen-history. Matched on canonical href.
  const dismissed = new Set(await listDismissedBoutique());
  const results = [];
  for (const b of boutiques) {
    let raw = [];
    try {
      const res = await read(b.url, { anchorPrefix: b.anchorPrefix || "/products/", fields: b.fields || {}, max: 60 });
      raw = res.items || [];
    } catch {
      results.push({ name: b.name, newItems: [], totalFound: 0, seeded: false, error: true });
      continue;
    }
    const base = (() => { try { return new URL(b.url).origin; } catch { return ""; } })();
    const all = normalizeBoutiqueItems(raw, base);
    const firstRun = !boutiquesSeen.has(b.name);
    const fresh = [];
    for (const it of all) {
      // Match dismissals on the absolute canonical URL: alerts (hence rejects) carry
      // absolute urls, feed items carry relative hrefs, and it.url reconciles both.
      if (dismissed.has(it.url)) continue; // family said "not right" -> never surface
      const id = hitId(b.name, it.href);
      if (known.has(id)) continue;
      known.add(id);
      await col.add({ id, name: b.name, href: it.href, at: now() });
      // Hone to the hunt list: alert only on listings matching a tracked piece.
      if (!firstRun && matchesAnyHunt(it.name, hunts)) fresh.push(it);
    }
    results.push({ name: b.name, newItems: fresh, totalFound: all.length, seeded: firstRun, error: false });
  }
  return results;
}
