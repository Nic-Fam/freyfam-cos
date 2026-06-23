// Saved-search registry for the resale specialist. This is the LOCAL data half of
// the resale capability: the agent can record, list, and remove the designer
// pieces the family is hunting. The heartbeat's "resale saved-search hits" TODO
// will later poll these against Poshmark/eBay/Vestiaire/RealReal/1stDibs; that
// fetch step needs live network access and is deliberately not done here.
//
// Stored as a small JSON file so it survives restarts with zero extra services.

import { randomUUID, createHash } from "node:crypto";
import { createCollection } from "./stores/collection.js";
import { webSearch } from "./search.js";

// Storage is pluggable (src/stores/collection.js): local JSON by default, or the
// resale specialist's own managed-identity Azure Table when COS_TABLE_* is set
// (remote on a Flex Function). Same add/list/remove API either way, so callers
// and the resale tools are unchanged.
const col = () =>
  createCollection({
    file: process.env.SAVED_SEARCHES_PATH || "./data/saved-searches.json",
    partition: "savedsearch",
  });

/** @param {{label?:string, query:string, maxPrice?:number|null, sites?:string[]}} input */
export async function addSavedSearch({ label, query, maxPrice = null, sites = [] } = {}) {
  if (!query || !String(query).trim()) throw new Error("query is required");
  const item = {
    id: randomUUID().slice(0, 8),
    label: label || query,
    query: String(query).trim(),
    maxPrice: maxPrice == null ? null : Number(maxPrice),
    sites: Array.isArray(sites) ? sites : [],
    createdAt: new Date().toISOString(),
  };
  await col().add(item);
  return item;
}

export async function listSavedSearches() {
  return col().list();
}

/** @returns {boolean} whether an item was actually removed */
export async function removeSavedSearch(id) {
  return col().remove(id);
}

// --- persistent search runner + hit tracker --------------------------------
// Running a saved search = web-search its query and surface matches. We track
// every hit we've ALREADY surfaced (one row per searchId+url) so each run reports
// only NEW finds and never repeats. Web search is fine on the remote resale
// specialist (it's an API call, not the local browser); a deeper price/condition
// check on a listing page is browse_page, which Lloyd runs locally on resale's
// behalf. Uses only add/list, so it works local OR on resale's Azure table.
const hits = () =>
  createCollection({
    file: process.env.SAVED_SEARCH_HITS_PATH || "./data/saved-search-hits.json",
    partition: "savedsearchhit",
  });

const hitId = (searchId, url) => createHash("sha1").update(`${searchId}|${url}`).digest("hex").slice(0, 12);

/**
 * Run every saved search and report NEW matches (deduped against past hits).
 * `search` is injectable for tests. Returns
 * [{ id, label, maxPrice, newHits:[{title,url,snippet}], totalFound }].
 */
export async function runSavedSearches({ search = webSearch, count } = {}) {
  const searches = await listSavedSearches();
  if (!searches.length) return [];
  const seen = new Set((await hits().list()).map((h) => h.id));
  const out = [];
  for (const s of searches) {
    const query = `${s.query}${s.maxPrice ? ` under $${s.maxPrice}` : ""}`;
    let results = [];
    try {
      results = await search(query, count ? { count } : {});
    } catch {
      results = []; // a provider hiccup on one search must not sink the rest
    }
    const newHits = [];
    for (const r of results) {
      if (!r.url) continue;
      const id = hitId(s.id, r.url);
      if (seen.has(id)) continue;
      seen.add(id);
      newHits.push(r);
      await hits().add({ id, searchId: s.id, url: r.url, title: r.title, firstSeenAt: new Date().toISOString() });
    }
    out.push({ id: s.id, label: s.label, maxPrice: s.maxPrice, newHits, totalFound: results.length });
  }
  return out;
}

/** Human summary of a run: new finds per saved search. */
export function formatSavedSearchRun(runResults) {
  if (!runResults || !runResults.length) return "No saved searches to run.";
  const withNew = runResults.filter((r) => r.newHits.length);
  if (!withNew.length) return "Ran the saved searches; no new matches since last time.";
  return withNew
    .map((r) => `${r.label}${r.maxPrice ? ` (under $${r.maxPrice})` : ""}: ${r.newHits.length} new\n` +
      r.newHits.map((h) => `  - ${h.title}\n    ${h.url}`).join("\n"))
    .join("\n");
}
