import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// Isolate the saved-search hit store for the hone test.
const HITS = join(os.tmpdir(), "cos-resale-hunt-hits.json");
process.env.SAVED_SEARCH_HITS_PATH = HITS;

const { runHuntSearch, formatHuntFinds } = await import("../src/resale-hunt.js");
const { runSavedSearches } = await import("../src/saved-searches.js");

beforeEach(() => rm(HITS, { force: true }));
after(() => rm(HITS, { force: true }));

const HUNTS = [{ id: "h1", num: 1, label: "Dior Ethnie feather sandal", query: "Christian Dior Ethnie feather sandal", sites: ["ebay"] }];

test("runHuntSearch merges sites + boutiques + First Look into ONE labelled list", async () => {
  const r = await runHuntSearch({
    hunts: HUNTS,
    siteRunner: async () => [{ label: "Dior sandal", newHits: [{ title: "Dior Ethnie sandal", url: "https://ebay.com/itm/1", price: 120 }] }],
    boutiqueRunner: async () => [{ name: "Allison's Archive", newItems: [{ name: "Dior feather sandal", url: "https://allisons.com/products/dior", price: 200 }] }],
    firstLookRunner: async () => ({ newItems: [{ brand: "Christian Dior", item: "Ethnie sandal", url: "https://therealreal.com/products/x", price: 300 }] }),
  });
  assert.equal(r.newItems.length, 3);
  assert.deepEqual(r.counts, { site: 1, boutique: 1, firstlook: 1 });
  assert.deepEqual([...new Set(r.newItems.map((i) => i.source))].sort(), ["boutique", "firstlook", "site"]);
});

test("runHuntSearch dedupes the same listing surfaced by two sources", async () => {
  const shared = "https://therealreal.com/products/dior-ethnie";
  const r = await runHuntSearch({
    hunts: HUNTS,
    siteRunner: async () => [{ label: "Dior", newHits: [{ title: "Dior Ethnie", url: shared, price: 99 }] }],
    boutiqueRunner: async () => [],
    firstLookRunner: async () => ({ newItems: [{ brand: "Dior", item: "Ethnie", url: shared, price: 99 }] }),
  });
  assert.equal(r.newItems.length, 1, "same URL across sources collapses to one find");
});

test("runHuntSearch with no hunts stays silent, and one bad source doesn't sink the rest", async () => {
  assert.deepEqual((await runHuntSearch({ hunts: [] })).newItems, []);
  const r = await runHuntSearch({
    hunts: HUNTS,
    siteRunner: async () => { throw new Error("provider down"); },
    boutiqueRunner: async () => [{ name: "Shop", newItems: [{ name: "Dior sandal", url: "https://s.com/products/a" }] }],
    firstLookRunner: async () => ({ newItems: [] }),
  });
  assert.equal(r.newItems.length, 1, "boutique find still surfaces when the site search throws");
});

test("hone flag on runSavedSearches keeps only results that read like the hunt", async () => {
  const runSites = async () => [
    { title: "Christian Dior Ethnie feather sandal 38.5", url: "https://ebay.com/itm/match", price: 120 },
    { title: "Nike running shoe", url: "https://ebay.com/itm/junk", price: 40 },
  ];
  const honed = await runSavedSearches({ searches: HUNTS, runSites, hone: true });
  assert.deepEqual(honed[0].newHits.map((h) => h.url), ["https://ebay.com/itm/match"], "junk filtered out");

  await rm(HITS, { force: true });
  const unhoned = await runSavedSearches({ searches: HUNTS, runSites, hone: false });
  assert.equal(unhoned[0].newHits.length, 2, "without honing, both raw results pass through");
});

test("formatHuntFinds groups by source and reads cleanly", () => {
  assert.equal(formatHuntFinds([]), "");
  const out = formatHuntFinds([
    { source: "site", title: "Dior sandal", url: "https://e.com/1", price: 120 },
    { source: "boutique", title: "Dior feather", url: "https://b.com/2", price: null },
  ]);
  assert.match(out, /Sites:/);
  assert.match(out, /Boutiques:/);
  assert.match(out, /Dior sandal \(\$120\)/);
});
