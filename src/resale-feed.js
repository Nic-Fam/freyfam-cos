import { createHash } from "node:crypto";
import { createCollection } from "./stores/collection.js";
import { readListingFeed } from "./channels/browser.js";
import { matchesAnyHunt } from "./saved-searches.js";

// ===========================================================================
// TheRealReal First Look feed. First Look is Shelli's paid early-access tier:
// members see new luxury arrivals BEFORE the public, so a generic web search
// (saved-searches.js) can't see them — only a signed-in browser can. The resale
// run reads the new-arrivals grid locally (Lloyd's Mac, Shelli's signed-in Chrome
// profile) and surfaces items we haven't reported before, so First Look behaves
// like a push feed. Reading the page = the LOCAL browser (readListingFeed), same
// posture as price-watch; nothing here acts or spends.
//
// Selectors captured live 2026-06-23 from the men's new-arrivals grid: each card
// exposes data-testid product-card/brand, product-card/description, and
// product-price/final. The card root has no stable class, so readListingFeed
// isolates a card by climbing from its /products/ anchor (see browser.js).
// ===========================================================================

const TRR = {
  base: "https://www.therealreal.com",
  // The new-arrivals grid. Signed in as a First Look member, this surfaces
  // early-access items first. Override TRR_FEED_URL to pin a gender/category
  // (e.g. men's: ...shop-new-arrivals-5753?taxons[]=<id>); the taxon ids shift,
  // so the safe default is the all-new-arrivals grid.
  feedUrl: process.env.TRR_FEED_URL || "https://www.therealreal.com/sales/shop-new-arrivals-5753",
  anchorPrefix: "/products/",
  fields: {
    brand: '[data-testid="product-card/brand"]',
    description: '[data-testid="product-card/description"]',
    price: '[data-testid="product-price/final"]',
  },
};

// One row per item href we've already surfaced, so each run reports only NEW
// arrivals. Pluggable store like saved-search hits (local JSON or resale's table).
const feedHits = () =>
  createCollection({
    file: process.env.RESALE_FEED_HITS_PATH || "./data/resale-feed-hits.json",
    partition: "resalefeedhit",
  });

const hitId = (href) => createHash("sha1").update(String(href)).digest("hex").slice(0, 12);

/**
 * Turn raw feed rows ({href, brand, description, price-text}) into clean items
 * ({href, url, brand, item, price:number|null}). Dedupes by href, parses the
 * dollar amount out of the price text, and strips the brand that TheRealReal
 * repeats at the start of the description. Pure.
 */
export function normalizeFeedItems(items, { base = TRR.base } = {}) {
  const out = [];
  const seen = new Set();
  for (const it of items || []) {
    if (!it || !it.href || seen.has(it.href)) continue;
    seen.add(it.href);
    const m = String(it.price || "").match(/\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/);
    const price = m ? Number(m[1].replace(/,/g, "")) : null;
    let item = String(it.description || "").trim();
    const brand = (it.brand || "").trim();
    if (brand && item.toLowerCase().startsWith(brand.toLowerCase())) item = item.slice(brand.length).trim();
    out.push({
      href: it.href,
      url: /^https?:\/\//i.test(it.href) ? it.href : base + it.href,
      brand: brand || null,
      item: item || null,
      price,
    });
  }
  return out;
}

/** Human summary of new feed finds. Pure. */
export function formatFeedItems(items, { max = 12 } = {}) {
  if (!items || !items.length) return "";
  const lines = items.slice(0, max).map((i) => {
    const name = [i.brand, i.item].filter(Boolean).join(" ") || "New listing";
    return `- ${name}${i.price != null ? ` ($${i.price})` : ""}\n  ${i.url}`;
  });
  if (items.length > max) lines.push(`...and ${items.length - max} more`);
  return lines.join("\n");
}

/**
 * Read the First Look / new-arrivals feed locally and return the NEW items since
 * the last run (deduped against the hit store). On the FIRST ever run the store is
 * empty, so we seed it silently (record everything, surface nothing) instead of
 * dumping the whole grid; only genuinely new arrivals surface thereafter.
 *
 * `hunts` hones the feed to the specific pieces the family is tracking: a new
 * arrival only surfaces if it matches one of the saved searches. Every seen href is
 * still recorded (so a non-match never re-surfaces later either); we just don't
 * ALERT on arrivals that aren't one of the hunted items. The hunt list is the ONLY
 * source of scope, so with NO hunts the feed surfaces nothing (it never falls back
 * to dumping the whole grid). `read` is injectable for tests.
 * Returns {newItems, totalFound, seeded, error}.
 */
export async function runFirstLookFeed({ read = readListingFeed, hunts = [], now = () => new Date().toISOString() } = {}) {
  let raw = [];
  try {
    const res = await read(TRR.feedUrl, { anchorPrefix: TRR.anchorPrefix, fields: TRR.fields, max: 60 });
    raw = res.items || [];
  } catch {
    return { newItems: [], totalFound: 0, seeded: false, error: true };
  }
  const all = normalizeFeedItems(raw);
  const col = feedHits();
  const known = new Set((await col.list()).map((h) => h.id));
  const firstRun = known.size === 0;
  const fresh = [];
  for (const it of all) {
    const id = hitId(it.href);
    if (known.has(id)) continue;
    await col.add({ id, href: it.href, brand: it.brand, price: it.price, at: now() });
    // Hone to the hunt list: alert only on arrivals matching a tracked piece, not
    // the whole grid. (The href is recorded above regardless, so it never resurfaces.)
    if (!firstRun && matchesAnyHunt(`${it.brand || ""} ${it.item || ""}`, hunts)) fresh.push(it);
  }
  return { newItems: fresh, totalFound: all.length, seeded: firstRun, error: false };
}

export const _TRR = TRR; // exported for tests / config visibility
