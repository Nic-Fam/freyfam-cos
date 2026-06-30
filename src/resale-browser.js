import { readListingFeed } from "./channels/browser.js";

// ===========================================================================
// Local-browser resale sources for sites with NO official search API. These
// read a site's search-results grid with the SAME signed-in-Chrome reader used
// for TheRealReal's First Look feed (channels/browser.js readListingFeed), so
// they run locally on Lloyd's Mac and cost nothing (vs. metered Brave search).
//
// SELECTORS NEED LIVE CAPTURE: `anchorPrefix` is the product-link path each site
// uses (the reliable, slow-to-change part); `fields` are CSS selectors WITHIN a
// card and SHOULD be verified/tuned live on Lloyd's signed-in Chrome, exactly
// how TheRealReal's were captured (see resale-feed.js). Where a title selector
// misses, normalization falls back to a slug derived from the listing URL, so a
// hunt still surfaces a usable name + link before selectors are tuned.
//
// Only sites with a DEFENSIBLE product-link prefix live here. Sites whose
// product URLs have no clean shared prefix (Vestiaire, Mytheresa) are left OUT
// on purpose and fall back to Brave (see resale-sources.js) rather than ship a
// broad-matching scraper that grabs every link on the page.
// ===========================================================================

export const RESALE_SITES = {
  // TheRealReal: card field selectors are the ones captured live 2026-06-23 for
  // the product grid (resale-feed.js). Search URL is best-effort; confirm live.
  therealreal: {
    base: "https://www.therealreal.com",
    searchUrl: (q) => `https://www.therealreal.com/products?keywords=${encodeURIComponent(q)}`,
    anchorPrefix: "/products/",
    fields: {
      title: '[data-testid="product-card/description"]',
      price: '[data-testid="product-price/final"]',
    },
  },
  poshmark: {
    base: "https://poshmark.com",
    searchUrl: (q) => `https://poshmark.com/search?query=${encodeURIComponent(q)}`,
    anchorPrefix: "/listing/",
    fields: { title: "[class*='title']", price: "[class*='price']" },
  },
  depop: {
    base: "https://www.depop.com",
    searchUrl: (q) => `https://www.depop.com/search/?q=${encodeURIComponent(q)}`,
    anchorPrefix: "/products/",
    fields: { price: "[aria-label*='rice'], p[class*='rice']" },
  },
  grailed: {
    base: "https://www.grailed.com",
    searchUrl: (q) => `https://www.grailed.com/shop?query=${encodeURIComponent(q)}`,
    anchorPrefix: "/listings/",
    fields: { title: "[class*='itle']", price: "[class*='rice']" },
  },
};

/** True when a site has a local-browser config (vs. needing the Brave fallback). */
export function isBrowserSite(siteKey) {
  return Boolean(RESALE_SITES[siteKey]);
}

/**
 * Best-effort human title from a listing URL slug, for when no title selector
 * matched. e.g. "/listing/64f-Nike-Air-Max-90" -> "Nike Air Max 90". Pure.
 */
export function slugToTitle(href) {
  try {
    const path = String(href).split("?")[0].replace(/\/+$/, "");
    let seg = decodeURIComponent(path.split("/").filter(Boolean).pop() || "");
    seg = seg.replace(/\.\w+$/, "");      // drop .shtml/.html
    seg = seg.replace(/^[0-9a-f]+[-_]/i, ""); // drop a leading id token
    seg = seg.replace(/[-_]+/g, " ").trim();
    return seg || null;
  } catch {
    return null;
  }
}

/**
 * Normalize raw feed rows ({href, title?, price?-text}) to our standard result
 * shape [{title,url,snippet,price}]. Dedupes by href, makes URLs absolute,
 * parses the dollar amount, falls back title -> slug -> url, and drops items
 * KNOWN to be over maxPrice (unknown-price items are kept, not hidden). Pure.
 */
export function normalizeBrowserRows(rows, { base = "", maxPrice = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const r of rows || []) {
    const href = r?.href;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const url = /^https?:\/\//i.test(href) ? href : base + href;
    const m = String(r.price || "").match(/\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/);
    const price = m ? Number(m[1].replace(/,/g, "")) : null;
    if (maxPrice != null && price != null && price > Number(maxPrice)) continue;
    const title = (r.title && String(r.title).trim()) || slugToTitle(href) || url;
    out.push({ title, url, snippet: price != null ? `$${price}` : "", price });
  }
  return out;
}

/**
 * Search one no-API site via the local browser. Returns [{title,url,snippet,
 * price}] (empty on any read failure / sign-in wall, so it never sinks a run).
 * `read` injectable for tests.
 */
export async function browserSiteSearch(siteKey, query, { maxPrice = null, max = 40, read = readListingFeed } = {}) {
  const site = RESALE_SITES[siteKey];
  if (!site) return [];
  const q = String(query || "").trim();
  if (!q) return [];
  let rows = [];
  try {
    const res = await read(site.searchUrl(q), { anchorPrefix: site.anchorPrefix, fields: site.fields || {}, max });
    rows = res.items || [];
  } catch {
    return [];
  }
  return normalizeBrowserRows(rows, { base: site.base, maxPrice });
}
