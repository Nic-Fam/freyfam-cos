// Saved-search registry for the resale specialist. This is the LOCAL data half of
// the resale capability: the agent can record, list, and remove the designer
// pieces the family is hunting. runSavedSearches() polls them against each hunt's
// target sites via the source router (resale-sources.js): eBay's free API,
// the local signed-in browser for TheRealReal/Poshmark/Depop/Grailed, and Brave
// for the rest. The fetch needs live network/browser access and lives there.
//
// Stored as a small JSON file so it survives restarts with zero extra services.

import { randomUUID, createHash } from "node:crypto";
import { createCollection } from "./stores/collection.js";
import { forget } from "./memory.js";
import { webSearch } from "./search.js";
import { runSiteSearch, isLocalSite } from "./resale-sources.js";

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
  // A short, stable, human-friendly NUMBER on each item so the family can refer to
  // "search #3" without confusing similar hunts (the 8-char id is the internal key).
  // Monotonic (max+1), so numbers are never reused even after a removal.
  const existing = await listSavedSearches();
  const nextNum = existing.reduce((mx, s) => Math.max(mx, s.num || 0), 0) + 1;
  const item = {
    id: randomUUID().slice(0, 8),
    num: nextNum,
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
  const items = await col().list();
  // Backfill numbers for any legacy item created before `num` existed, assigning by
  // creation order so existing hunts get stable low numbers. Persist once.
  const missing = items.filter((s) => s.num == null);
  if (missing.length) {
    const c = col();
    let next = items.reduce((mx, s) => Math.max(mx, s.num || 0), 0);
    for (const it of [...missing].sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))) {
      it.num = ++next;
      await c.remove(it.id).catch(() => {});
      await c.add(it);
    }
  }
  return items.sort((a, b) => (a.num || 0) - (b.num || 0));
}

// Remove the accumulated hits for a search so a deleted hunt leaves no stale
// matches behind (part of making a removal actually STICK).
async function removeHitsFor(searchId) {
  const all = await hits().list();
  let n = 0;
  for (const h of all.filter((x) => x.searchId === searchId)) { await hits().remove(h.id); n += 1; }
  return n;
}

// After a hunt is deleted, forget the "Active archive hunt: ..." brain memory that
// would otherwise resurface it (in recall/digest, or by prompting a re-add).
// Conservative: only resale memories that mention a hunt AND share the piece's
// leading term (usually the brand), so a standing brand-interest fact
// ("Shelli tracks MSGM") is preserved.
async function forgetHuntMemory(item) {
  const brand = (String(item?.label || item?.query || "").toLowerCase().match(/[a-z0-9]+/g) || [])[0];
  if (!brand) return 0;
  return forget((m) =>
    m?.meta?.agent === "resale" &&
    /\b(hunt|archive)\b/i.test(m.text || "") &&
    String(m.text || "").toLowerCase().includes(brand)
  );
}

/**
 * Remove a saved search by its NUMBER (e.g. 3 or "#3") or its 8-char id, and
 * CASCADE: drop its past hits and forget the hunt's brain memory, so it does not
 * resurface. @returns {boolean} whether an item was actually removed
 */
export async function removeSavedSearch(idOrNum) {
  const items = await listSavedSearches();
  // Resolve an exact id FIRST: an 8-char hex id can be all-digits, so we must not
  // mistake one for a search number. Only fall back to a number lookup.
  let target = items.find((s) => s.id === idOrNum);
  if (!target) {
    const numKey = String(idOrNum).trim().replace(/^#/, "");
    if (/^\d+$/.test(numKey)) target = items.find((s) => String(s.num) === numKey);
  }
  if (!target) return false;
  const ok = await col().remove(target.id);
  if (ok) { await removeHitsFor(target.id); await forgetHuntMemory(target); }
  return ok;
}

/**
 * Remove an ENTIRE hunt by a text term matched against label/query. A piece is
 * usually registered as several per-site searches, so this clears them all at once
 * (each cascades hits), then forgets the hunt memory. @returns {{count, labels}}
 */
export async function removeHunt(term) {
  const t = String(term || "").trim().toLowerCase();
  if (!t) return { count: 0, labels: [] };
  const items = await listSavedSearches();
  const matches = items.filter((s) => `${s.label || ""} ${s.query || ""}`.toLowerCase().includes(t));
  const labels = [];
  for (const s of matches) {
    if (await col().remove(s.id)) { await removeHitsFor(s.id); labels.push(s.label || s.id); }
  }
  if (matches[0]) await forgetHuntMemory(matches[0]);
  return { count: labels.length, labels };
}

/** Human "hunt list" with each item's number. Pure. */
export function formatSavedSearchList(items) {
  if (!items || !items.length) return "No saved searches yet.";
  return `Hunt list (${items.length}):\n` + items
    .map((s) => `#${s.num} ${s.label}` +
      (s.maxPrice ? ` (under $${s.maxPrice})` : "") +
      (s.sites?.length ? ` [${s.sites.join(", ")}]` : ""))
    .join("\n");
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
 * Run saved searches and report NEW matches (deduped against past hits). Each
 * hunt is routed by its `sites` (see resale-sources.js): eBay -> free API,
 * therealreal/poshmark/depop/grailed -> local browser, the rest -> Brave. A hunt
 * with NO sites keeps the original behavior: one Brave query with the price cap
 * folded into the text.
 *
 * `scope` selects which sources run, so browser-only sites stay on Lloyd:
 *   "all"    (default) every source — used in LOCAL mode / tests.
 *   "remote" only API/Brave sources — what the REMOTE (Azure) specialist runs;
 *            it has no browser, so browser-only sites are skipped cleanly.
 *   "local"  only browser-only sites — what Lloyd runs on the remote specialist's
 *            behalf (see heartbeat maybeRunResale + the hunt bridge below).
 * `searches` overrides the registry read (Lloyd passes hunts pulled from the
 * remote specialist over the delegate seam). `search`/`runSites` injectable.
 * Returns [{ id, label, maxPrice, newHits:[{title,url,snippet,price?}], totalFound }].
 */
export async function runSavedSearches({ search = webSearch, count, runSites = runSiteSearch, scope = "all", searches = null } = {}) {
  const list = searches || (await listSavedSearches());
  if (!list.length) return [];
  const seen = new Set((await hits().list()).map((h) => h.id));
  const out = [];
  for (const s of list) {
    const sites = Array.isArray(s.sites) ? s.sites : [];
    let results = [];
    try {
      if (sites.length) {
        // Restrict to the sources allowed in this scope (browser-only vs not).
        const scoped =
          scope === "all" ? sites :
          scope === "local" ? sites.filter(isLocalSite) :
          sites.filter((x) => !isLocalSite(x)); // remote
        if (!scoped.length) continue; // this hunt has nothing to run in this scope
        results = await runSites(s.query, { sites: scoped, maxPrice: s.maxPrice, count, braveSearch: search });
      } else {
        // No site named: a Brave hunt. Not a browser-only hunt, so skip in "local".
        if (scope === "local") continue;
        const query = `${s.query}${s.maxPrice ? ` under $${s.maxPrice}` : ""}`;
        results = await search(query, count ? { count } : {});
      }
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
      await hits().add({ id, searchId: s.id, url: r.url, title: r.title, price: r.price ?? null, firstSeenAt: new Date().toISOString() });
    }
    out.push({ id: s.id, num: s.num, label: s.label, maxPrice: s.maxPrice, newHits, totalFound: results.length });
  }
  return out;
}

// --- hunt bridge (remote specialist -> Lloyd's local browser) --------------
// When resale runs REMOTE (Azure), the saved-search registry lives in resale's
// own store and the local browser is not there. To run the browser-only sites,
// Lloyd pulls the hunt list back over the EXISTING delegate seam (resale returns
// it as text), then runs those sites locally. No reverse channel, no Lloyd
// reading resale's store directly: the specialist still just RETURNS text.

const EXPORT_TASK =
  "Call export_saved_searches and reply with ONLY its raw JSON output (a JSON array), no prose, no code fences.";

/**
 * Extract the JSON array of hunts from a (possibly chatty) specialist reply.
 * Tolerant: grabs the first [...] block, returns [] on anything unparseable so a
 * bad reply degrades to "no browser hunts this run" instead of throwing. Pure.
 */
export function parseHuntsJson(text) {
  const m = String(text || "").match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return Array.isArray(arr) ? arr.filter((h) => h && h.query) : [];
  } catch {
    return [];
  }
}

/** Ask the resale specialist (over delegate) for its hunt list as JSON. `delegate` injected. */
export async function fetchHuntsViaDelegate(delegate, { task = EXPORT_TASK } = {}) {
  const text = await delegate({ agent: "resale", task });
  return parseHuntsJson(text);
}

/** Human summary of a run: new finds per saved search. */
export function formatSavedSearchRun(runResults) {
  if (!runResults || !runResults.length) return "No saved searches to run.";
  const withNew = runResults.filter((r) => r.newHits.length);
  if (!withNew.length) return "Ran the saved searches; no new matches since last time.";
  return withNew
    .map((r) => `${r.num ? `#${r.num} ` : ""}${r.label}${r.maxPrice ? ` (under $${r.maxPrice})` : ""}: ${r.newHits.length} new\n` +
      r.newHits.map((h) => `  - ${h.title}${h.price != null ? ` ($${h.price})` : ""}\n    ${h.url}`).join("\n"))
    .join("\n");
}
