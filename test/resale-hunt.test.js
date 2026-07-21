import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// Isolate the saved-search hit store for the hone test.
const HITS = join(os.tmpdir(), "cos-resale-hunt-hits.json");
process.env.SAVED_SEARCH_HITS_PATH = HITS;

const { runHuntSearch, formatHuntFinds, assessCandidates, looksLikeListing, hasDistinctive, distinctiveTokens } =
  await import("../src/resale-hunt.js");
const { runSavedSearches } = await import("../src/saved-searches.js");

beforeEach(() => rm(HITS, { force: true }));
after(() => rm(HITS, { force: true }));

const HUNTS = [{ id: "h1", num: 1, label: "Dior Ethnie feather sandal", query: "Christian Dior Ethnie feather sandal", sites: ["ebay"] }];
// A pass-through assessor: every candidate is a confident match (isolates gather/pre-filter).
const passAll = async (cands) => cands.map((c) => ({ ...c, likelihood: 90, reason: "match" }));

test("runHuntSearch merges sites + boutiques + First Look into ONE labelled list", async () => {
  const r = await runHuntSearch({
    hunts: HUNTS,
    assess: passAll,
    siteRunner: async () => [{ label: "Dior sandal", newHits: [{ title: "Christian Dior Ethnie sandal", url: "https://ebay.com/itm/1", price: 120 }] }],
    boutiqueRunner: async () => [{ name: "Allison's Archive", newItems: [{ name: "Dior Ethnie feather sandal", url: "https://allisons.com/products/dior-ethnie", price: 200 }] }],
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
    assess: passAll,
    siteRunner: async () => [{ label: "Dior", newHits: [{ title: "Christian Dior Ethnie", url: shared, price: 99 }] }],
    boutiqueRunner: async () => [],
    firstLookRunner: async () => ({ newItems: [{ brand: "Dior", item: "Ethnie", url: shared, price: 99 }] }),
  });
  assert.equal(r.newItems.length, 1, "same URL across sources collapses to one find");
});

test("runHuntSearch: no hunts stays silent; one bad source doesn't sink the rest", async () => {
  assert.deepEqual((await runHuntSearch({ hunts: [] })).newItems, []);
  const r = await runHuntSearch({
    hunts: HUNTS,
    assess: passAll,
    siteRunner: async () => { throw new Error("provider down"); },
    boutiqueRunner: async () => [{ name: "Shop", newItems: [{ name: "Dior Ethnie sandal", url: "https://s.com/products/a-dior" }] }],
    firstLookRunner: async () => ({ newItems: [] }),
  });
  assert.equal(r.newItems.length, 1, "boutique find still surfaces when the site search throws");
});

test("pre-filter drops category/landing-page URLs and generic-only items before assessment", async () => {
  let received = null;
  const captureAssess = async (cands) => { received = cands; return cands.map((c) => ({ ...c, likelihood: 90 })); };
  await runHuntSearch({
    hunts: HUNTS,
    assess: captureAssess,
    siteRunner: async () => [{
      label: "Dior", newHits: [
        { title: "CHRISTIAN DIOR Women Sandals - Vestiaire Collective", url: "https://us.vestiairecollective.com/women-shoes/sandals/christian-dior/" }, // category page
        { title: "Plain leather sandals", url: "https://poshmark.com/listing/plain-leather-sandals-123" }, // no distinctive term
        { title: "Christian Dior Ethnie feather sandal", url: "https://poshmark.com/listing/dior-ethnie-abc" }, // real candidate
      ],
    }],
    boutiqueRunner: async () => [],
    firstLookRunner: async () => ({ newItems: [] }),
  });
  assert.equal(received.length, 1, "only the real Dior listing reaches the assessor");
  assert.match(received[0].url, /dior-ethnie-abc/);
});

test("looksLikeListing separates real listings from category/search pages", () => {
  assert.equal(looksLikeListing("https://us.vestiairecollective.com/women-shoes/sandals/christian-dior/"), false);
  assert.equal(looksLikeListing("https://us.vestiairecollective.com/women-clothing/tops/dsquared2/red-cotton-dsquared2-top-54796681.shtml"), true);
  assert.equal(looksLikeListing("https://poshmark.com/listing/Dior-Ethnie-6a54"), true);
  assert.equal(looksLikeListing("https://poshmark.com/search?query=dior"), false);
  assert.equal(looksLikeListing("https://ebay.com/itm/12345"), true);
});

test("distinctiveTokens/hasDistinctive ignore generic fashion words", () => {
  assert.deepEqual(distinctiveTokens({ query: "Christian Dior Ethnie feather sandal", label: "" }).sort(), ["christian", "dior", "ethnie", "feather"]);
  assert.equal(hasDistinctive("Some feather sandal", HUNTS), true, "'feather' is distinctive");
  assert.equal(hasDistinctive("Plain leather sandals size 9", HUNTS), false, "only generic words -> no distinctive match");
});

test("assessCandidates scores via the model and drops anything below the floor", async () => {
  const cands = [
    { source: "site", title: "Christian Dior Ethnie feather sandal", url: "https://p.com/listing/1", price: 120 },
    { source: "site", title: "Hale Bob feather sandal", url: "https://p.com/listing/2", price: 40 },
  ];
  const completeImpl = async () => ({ content: [{ type: "text", text: JSON.stringify({ verdicts: [
    { i: 0, hunt: 1, likelihood: 88, reason: "Dior Ethnie, feathers match" },
    { i: 1, hunt: null, likelihood: 10, reason: "wrong brand (Hale Bob)" },
  ] }) }] });
  const out = await assessCandidates(cands, HUNTS, { floor: 60, completeImpl });
  assert.equal(out.length, 1, "the wrong-brand item is dropped");
  assert.equal(out[0].likelihood, 88);
  assert.match(out[0].reason, /Ethnie/);
});

test("assessCandidates degrades to unscored (never silently drops) if the model call fails", async () => {
  const cands = [{ source: "site", title: "Christian Dior Ethnie sandal", url: "https://p.com/listing/1" }];
  const completeImpl = async () => { throw new Error("api down"); };
  const out = await assessCandidates(cands, HUNTS, { floor: 60, completeImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].likelihood, null);
  assert.match(out[0].reason, /unscored/);
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

test("formatHuntFinds shows the likelihood and reason, grouped by source", () => {
  assert.equal(formatHuntFinds([]), "");
  const out = formatHuntFinds([
    { source: "site", title: "Dior Ethnie sandal", url: "https://e.com/1", price: 120, likelihood: 88, reason: "feathers match" },
    { source: "boutique", title: "Dior feather", url: "https://b.com/2", price: null, likelihood: null, reason: "" },
  ]);
  assert.match(out, /Sites:/);
  assert.match(out, /\[88%\] Dior Ethnie sandal \(\$120\) -- feathers match/);
  assert.match(out, /Boutiques:/);
});
