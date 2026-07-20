// Seed Shey's saved-search hunt list with the family's CURRENTLY tracked pieces.
// Idempotent: a hunt whose query already exists (case-insensitive) is skipped, so
// re-running never piles up duplicates. Honors SAVED_SEARCHES_PATH like the rest of
// the app, so it writes to the same store the daemon reads (local JSON by default,
// or resale's Azure table when COS_TABLE_* is set).
//
// This is the ONLY source of what Shey hunts. As of 2026-07 the family tracks
// exactly two pieces; edit HUNTS and re-run to change the list, or use
// add_saved_search / remove_saved_search through Shey for one-offs.
//
// WHERE IT WRITES (read before running): this writes to whatever store the env
// points at. When resale runs REMOTE (COS_SPECIALIST_MODE=remote + a resale
// endpoint), Shey reads her OWN Azure Table, not local JSON. Running this on
// Lloyd without COS_TABLE_* then seeds ./data/saved-searches.json, which the
// remote Shey never reads -- the hunts look "added" but never search. In that
// case, either set resale's COS_TABLE_* before running, or (simpler) add through
// Shey directly ("hunt the <piece>") so add_saved_search writes to her store.
// The guard below refuses this footgun unless SEED_HUNTS_FORCE_LOCAL=1.
//
// Usage:
//   node data/seed-hunts.mjs                        # local store (or COS_TABLE_* table)
//   COS_TABLE_ENDPOINT=... node data/seed-hunts.mjs # seed resale's remote table
//   SEED_HUNTS_FORCE_LOCAL=1 node data/seed-hunts.mjs  # force local write anyway
//
// Each hunt's `query` doubles as the search term sent to every source (platforms
// AND the archive boutiques) and as the text the new-arrival feeds hone against, so
// keep it a good, specific search phrase: brand + the distinctive descriptor.

import { addSavedSearch, listSavedSearches, formatSavedSearchList } from "../src/saved-searches.js";
import { usingTableStore } from "../src/stores/collection.js";

// Guard the footgun: resale remote + no table configured means we'd seed the local
// JSON store that the remote Shey never reads. Refuse with an actionable message
// unless the caller opts into a local write explicitly (dev/local-mode seeding).
if (process.env.COS_SPECIALIST_MODE === "remote" && !usingTableStore() && process.env.SEED_HUNTS_FORCE_LOCAL !== "1") {
  console.error(
    "Refusing to seed: resale runs REMOTE (COS_SPECIALIST_MODE=remote) but no COS_TABLE_* is set,\n" +
    "so this would write ./data/saved-searches.json -- a store the remote Shey never reads.\n" +
    "Do one of:\n" +
    "  - add through Shey directly:  text \"hunt the <piece>\" (writes to her own store), or\n" +
    "  - set resale's COS_TABLE_ENDPOINT / COS_TABLE_CONNECTION_STRING + COS_TABLE_NAME, then re-run, or\n" +
    "  - SEED_HUNTS_FORCE_LOCAL=1 to write the local store anyway (local/dev only)."
  );
  process.exit(1);
}

const HUNTS = [
  {
    label: "Dior Ethnie feather sandal (size 38.5)",
    query: "Christian Dior Ethnie feather sandal",
    // Black leather thong sandal with black feather straps. Retail ~$650; a comp
    // sold at $99. No hard price cap set — the confirmation gate handles any buy.
    maxPrice: null,
    sites: ["ebay", "therealreal", "vestiaire", "poshmark"],
  },
  {
    label: "Dsquared2 FW2014 feather-shoulder top",
    query: "Dsquared2 feather top",
    // Black long-sleeve top with black feather/paillette shoulders (Moira Rose,
    // Schitt's Creek "Opening Night" 3x01 — @dsquared2 Fall 2014).
    maxPrice: null,
    sites: ["ebay", "vestiaire", "therealreal", "grailed", "poshmark"],
  },
];

const norm = (s) => String(s || "").trim().toLowerCase();

const existing = await listSavedSearches();
const have = new Set(existing.map((s) => norm(s.query)));

let added = 0;
let skipped = 0;
for (const hunt of HUNTS) {
  if (have.has(norm(hunt.query))) {
    skipped++;
    continue;
  }
  await addSavedSearch(hunt);
  have.add(norm(hunt.query));
  added++;
}

console.log(`Seeded Shey's hunts: ${added} added, ${skipped} already present.`);
console.log(formatSavedSearchList(await listSavedSearches()));
