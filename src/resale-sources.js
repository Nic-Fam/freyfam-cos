import { webSearch } from "./search.js";
import { ebaySearch } from "./ebay.js";
import { browserSiteSearch, isBrowserSite } from "./resale-browser.js";

// ===========================================================================
// Source router for resale saved-searches. Maps each site a hunt targets to the
// cheapest source that can serve it, all behind ONE result shape
// [{title,url,snippet,price?}]:
//
//   ebay                         -> free official Browse API (ebay.js)
//   therealreal/poshmark/depop/grailed -> local signed-in Chrome (resale-browser.js)
//   anything else (vestiaire, mytheresa, or no known site) -> Brave web search,
//                                  scoped to the site's domain when we know it
//
// This is what lets resale hunts stop paying metered Brave search for the sites
// that have a real API or a local-browser path, while still working for the rest.
// ===========================================================================

// Canonical site key -> domain, for Brave domain-scoping of the fallback sites.
export const SITE_DOMAINS = {
  ebay: "ebay.com",
  therealreal: "therealreal.com",
  poshmark: "poshmark.com",
  depop: "depop.com",
  grailed: "grailed.com",
  vestiaire: "vestiairecollective.com",
  mytheresa: "mytheresa.com",
};

/** Normalize a user-entered site label to a canonical key ("eBay.com" -> "ebay"). */
export function normalizeSiteKey(site) {
  return String(site || "").trim().toLowerCase().replace(/^www\./, "").replace(/\.com$/, "");
}

/**
 * True when a site can ONLY be served by the local signed-in browser (Lloyd),
 * i.e. it has no API and no Brave-only path. These must run on Lloyd's host, not
 * the remote (Azure) resale specialist, which has no browser. eBay (API) and the
 * Brave-fallback sites (Vestiaire/Mytheresa/unknown) are NOT local-only.
 */
export function isLocalSite(site) {
  return isBrowserSite(normalizeSiteKey(site));
}

/**
 * Run ONE site for a query. Dependencies (ebay/browser/braveSearch) injectable
 * for tests. maxPrice is a structured cap for eBay/browser; for Brave (no price
 * filter) it is folded into the query text, same as the legacy behavior.
 */
export async function searchSite(siteKey, query, { maxPrice = null, count, braveSearch = webSearch, ebay = ebaySearch, browser = browserSiteSearch } = {}) {
  const key = normalizeSiteKey(siteKey);
  if (key === "ebay") return ebay(query, { maxPrice, ...(count ? { count } : {}) });
  if (isBrowserSite(key)) return browser(key, query, { maxPrice, ...(count ? { max: count } : {}) });
  // Brave fallback: scope to the domain when known so a "vestiaire" hunt still
  // targets the right site, and fold the price cap into the query text.
  const domain = SITE_DOMAINS[key];
  const q = `${query}${maxPrice ? ` under $${maxPrice}` : ""}${domain ? ` site:${domain}` : ""}`;
  return braveSearch(q, count ? { count } : {});
}

/**
 * Fan a query across all of a saved search's sites and merge, deduped by url.
 * One site failing yields [] for that site (it never throws the whole run), so
 * the others still report. Returns [{title,url,snippet,price?}].
 */
export async function runSiteSearch(query, { sites = [], maxPrice = null, count, braveSearch = webSearch, ebay = ebaySearch, browser = browserSiteSearch } = {}) {
  const out = [];
  const seen = new Set();
  for (const site of sites) {
    let results = [];
    try {
      results = await searchSite(site, query, { maxPrice, count, braveSearch, ebay, browser });
    } catch {
      results = [];
    }
    for (const r of results || []) {
      if (!r?.url || seen.has(r.url)) continue;
      seen.add(r.url);
      out.push(r);
    }
  }
  return out;
}
