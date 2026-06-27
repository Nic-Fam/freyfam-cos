import { createHash } from "node:crypto";
import { createCollection } from "./stores/collection.js";
import { readListingFeed } from "./channels/browser.js";

// ===========================================================================
// Per-marketplace saved-search fetchers for the resale specialist (Shey).
//
// runSavedSearches (saved-searches.js) runs a GENERIC web search per saved
// search — that works on the remote resale specialist because it is an API
// call. This module is the deeper, per-site layer: it reads each marketplace's
// own search-results grid through the LOCAL signed-in browser (readListingFeed),
// so we get real listings (title, price, link) ordered newest-first instead of
// whatever a web index happens to surface. Like the TheRealReal First Look feed
// (resale-feed.js) and price-watch, this is LOCAL-only (Lloyd's Mac): it needs a
// real browser, which the Azure specialists deliberately don't have. The
// heartbeat runs it on Lloyd's behalf right after the saved-search delegate.
//
// It surfaces only; it never buys. Any purchase is a high-stakes action that
// still goes through Lloyd's confirmation gate (hard constraint #2).
//
// SELECTOR STATUS: eBay's grid (.s-item__title/.s-item__price under /itm/) is
// stable and was the reference for the structured price signals in browser.js.
// Poshmark/Vestiaire/1stDibs selectors below are best-effort and want a live
// capture pass on the Mac (same convention as the dated TRR capture). Every
// fetcher degrades gracefully: a card whose fields don't match yields a null
// title/price, normalize drops it, and the run never throws — so a stale
// selector means "no finds", never a crash or garbage.
// ===========================================================================

const enc = (q) => encodeURIComponent(String(q || "").trim());

// One registry entry per marketplace. `url` builds the newest-first search URL;
// `anchorPrefix`/`anchorMatch` isolate a product card (see readListingFeed);
// `fields` map our keys to the card's title/price selectors.
const MARKETS = {
  ebay: {
    name: "eBay",
    base: "https://www.ebay.com",
    // _sop=10 sorts newest-first; _udhi caps the max price server-side.
    url: (q, { maxPrice } = {}) =>
      `https://www.ebay.com/sch/i.html?_nkw=${enc(q)}&_sop=10${maxPrice ? `&_udhi=${Number(maxPrice)}` : ""}`,
    anchorPrefix: "/itm/",
    fields: { title: ".s-item__title", price: ".s-item__price" },
  },
  poshmark: {
    name: "Poshmark",
    base: "https://poshmark.com",
    url: (q) => `https://poshmark.com/search?query=${enc(q)}&sort_by=added_desc`,
    anchorPrefix: "/listing/",
    fields: {
      title: '[data-test="item-title"], .tile__title',
      price: '[data-test="item-price"], .fw--bold, .p--t--1',
    },
  },
  vestiaire: {
    name: "Vestiaire Collective",
    base: "https://www.vestiairecollective.com",
    url: (q) => `https://www.vestiairecollective.com/search/?q=${enc(q)}`,
    // Product URLs end with "-<numeric id>.shtml"; there is no clean path prefix.
    anchorMatch: "-\\d+\\.shtml(?:[?#]|$)",
    fields: {
      title: '[data-cy="productCard-name"], .product-card__name',
      price: '[data-cy="productCard-price"], .product-card__price',
    },
  },
  "1stdibs": {
    name: "1stDibs",
    base: "https://www.1stdibs.com",
    url: (q) => `https://www.1stdibs.com/search/?q=${enc(q)}`,
    // Product URLs carry an "/id-<type>_<n>/" segment (id-f_… furniture,
    // id-j_… jewelry, id-v_… vintage, etc.).
    anchorMatch: "/id-[a-z]+_\\d+",
    fields: {
      title: '[data-tn="search-result-item-title"], .title',
      price: '[data-tn="price"], .price',
    },
  },
};

// Free-text site labels on a saved search ("eBay", "Vestiaire Collective",
// "1st dibs") map to a registry key. TheRealReal is intentionally absent: its
// member-only First Look feed has its own module (resale-feed.js).
const ALIASES = {
  ebay: "ebay",
  "e-bay": "ebay",
  poshmark: "poshmark",
  posh: "poshmark",
  vestiaire: "vestiaire",
  "vestiaire collective": "vestiaire",
  vc: "vestiaire",
  "1stdibs": "1stdibs",
  "1st dibs": "1stdibs",
  firstdibs: "1stdibs",
  "first dibs": "1stdibs",
};

/** Canonical marketplace key for a free-text site label, or null if unsupported. */
export function resolveMarketplace(site) {
  const s = String(site || "").trim().toLowerCase().replace(/\s+/g, " ");
  const key = ALIASES[s] || (MARKETS[s] ? s : null);
  return key && MARKETS[key] ? key : null;
}

export function listMarketplaces() {
  return Object.keys(MARKETS);
}

/**
 * Turn raw card rows ({href, title, price-text}) from one marketplace into clean
 * items ({href, url, title, price:number|null}). Absolutizes the url against the
 * site base, parses the dollar amount out of the price text, dedupes by href, and
 * drops obvious non-listings (empty title, eBay's "Shop on eBay" placeholder). Pure.
 */
export function normalizeMarketItems(marketKey, rawItems) {
  const market = MARKETS[marketKey];
  if (!market) return [];
  const out = [];
  const seen = new Set();
  for (const it of rawItems || []) {
    if (!it || !it.href || seen.has(it.href)) continue;
    const title = String(it.title || "").trim();
    if (!title || /^shop on ebay$/i.test(title)) continue; // placeholder / no-content card
    seen.add(it.href);
    const m = String(it.price || "").match(/\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/);
    const price = m ? Number(m[1].replace(/,/g, "")) : null;
    out.push({
      href: it.href,
      url: /^https?:\/\//i.test(it.href) ? it.href : market.base + it.href,
      title,
      price,
    });
  }
  return out;
}

// One row per (saved search, site, listing url) we've already surfaced, so each
// run reports only NEW finds. Pluggable store like the other resale hit trackers.
const marketHits = () =>
  createCollection({
    file: process.env.MARKETPLACE_HITS_PATH || "./data/marketplace-hits.json",
    partition: "markethit",
  });

const hitId = (searchId, site, href) =>
  createHash("sha1").update(`${searchId}|${site}|${href}`).digest("hex").slice(0, 12);

/**
 * Read each saved search across its requested marketplaces via the LOCAL browser
 * and return the NEW listings since the last run (deduped against the hit store).
 *
 * A (search, site) pair is SEEDED silently the first time it is ever read — the
 * whole grid is recorded but nothing surfaces — so adding a search or a site
 * doesn't dump dozens of pre-existing listings; only genuinely new arrivals
 * surface thereafter. maxPrice (when set on the search) drops over-budget items.
 * `read` is injectable for tests. One pair failing (stale selector, sign-in wall)
 * never sinks the rest.
 *
 * @param {{searches:Array, read?:Function, now?:Function, max?:number}} opts
 * @returns {Promise<Array<{searchId,label,site,siteName,newItems,totalFound,seeded,error}>>}
 */
export async function runMarketplaceFeeds({ searches = [], read = readListingFeed, now = () => new Date().toISOString(), max = 40 } = {}) {
  if (!searches.length) return [];
  const col = marketHits();
  const existing = await col.list();
  const out = [];

  for (const s of searches) {
    const sites = Array.isArray(s.sites) ? s.sites : [];
    for (const rawSite of sites) {
      const key = resolveMarketplace(rawSite);
      if (!key) continue; // unsupported site (e.g. TheRealReal -> First Look feed)
      const market = MARKETS[key];
      const result = { searchId: s.id, label: s.label || s.query, site: key, siteName: market.name, newItems: [], totalFound: 0, seeded: false, error: false };
      try {
        const res = await read(market.url(s.query, { maxPrice: s.maxPrice }), {
          anchorPrefix: market.anchorPrefix,
          anchorMatch: market.anchorMatch,
          fields: market.fields,
          max: 60,
        });
        let items = normalizeMarketItems(key, res.items || []);
        if (s.maxPrice != null) items = items.filter((i) => i.price == null || i.price <= Number(s.maxPrice));
        result.totalFound = items.length;

        // First read of this (search, site) pair -> seed silently.
        const firstRun = !existing.some((h) => h.searchId === s.id && h.site === key);
        const known = new Set(existing.filter((h) => h.searchId === s.id && h.site === key).map((h) => h.id));
        for (const it of items.slice(0, max)) {
          const id = hitId(s.id, key, it.href);
          if (known.has(id)) continue;
          known.add(id);
          existing.push({ id, searchId: s.id, site: key, href: it.href }); // keep in-memory set current for later pairs
          await col.add({ id, searchId: s.id, site: key, href: it.href, title: it.title, price: it.price, at: now() });
          if (!firstRun) result.newItems.push(it);
        }
        result.seeded = firstRun;
      } catch {
        result.error = true; // one bad pair must not sink the rest
      }
      out.push(result);
    }
  }
  return out;
}

/** Human summary of a marketplace run: new finds grouped per search+site. Pure. */
export function formatMarketRun(runResults, { max = 8 } = {}) {
  if (!runResults || !runResults.length) return "";
  const withNew = runResults.filter((r) => r.newItems.length);
  if (!withNew.length) return "";
  return withNew
    .map((r) => {
      const head = `${r.label} on ${r.siteName}: ${r.newItems.length} new`;
      const lines = r.newItems.slice(0, max).map((i) => `  - ${i.title}${i.price != null ? ` ($${i.price})` : ""}\n    ${i.url}`);
      if (r.newItems.length > max) lines.push(`  ...and ${r.newItems.length - max} more`);
      return [head, ...lines].join("\n");
    })
    .join("\n");
}

export const _MARKETS = MARKETS; // exported for tests / config visibility
