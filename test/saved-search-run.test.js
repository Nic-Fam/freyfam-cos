import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const SS = join(os.tmpdir(), "cos-ss-test.json");
const HITS = join(os.tmpdir(), "cos-ss-hits-test.json");
process.env.SAVED_SEARCHES_PATH = SS;
process.env.SAVED_SEARCH_HITS_PATH = HITS;
const ss = await import("../src/saved-searches.js");

beforeEach(async () => { await rm(SS, { force: true }); await rm(HITS, { force: true }); });
after(async () => { await rm(SS, { force: true }); await rm(HITS, { force: true }); });

test("runSavedSearches reports new hits once, then dedupes them on the next run", async () => {
  await ss.addSavedSearch({ query: "Margiela Tabi", label: "Tabis", maxPrice: 350 });
  let calls = 0;
  const fakeSearch = async (q) => {
    calls++;
    assert.match(q, /under \$350/); // maxPrice folded into the query
    return [
      { title: "Tabi 39", url: "https://vestiaire.com/a", snippet: "" },
      { title: "Tabi 40", url: "https://vestiaire.com/b", snippet: "" },
    ];
  };
  const first = await ss.runSavedSearches({ search: fakeSearch });
  assert.equal(first[0].newHits.length, 2);
  const second = await ss.runSavedSearches({ search: fakeSearch }); // same results
  assert.equal(second[0].newHits.length, 0, "already-seen hits are not repeated");
  assert.equal(calls, 2);
});

test("a hunt WITH sites routes through runSites (not the Brave query path)", async () => {
  await ss.addSavedSearch({ query: "Margiela Tabi", label: "Tabis", maxPrice: 350, sites: ["ebay", "poshmark"] });
  let braveCalls = 0, siteArgs = null;
  const run = await ss.runSavedSearches({
    search: async () => { braveCalls++; return []; },           // Brave must NOT be used
    runSites: async (query, opts) => {
      siteArgs = { query, opts };
      return [{ title: "Tabi 39", url: "https://ebay.com/itm/1", price: 320 }];
    },
  });
  assert.equal(braveCalls, 0, "site-targeted hunt does not hit Brave directly");
  assert.equal(siteArgs.query, "Margiela Tabi", "raw query (no folded price) goes to the router");
  assert.deepEqual(siteArgs.opts.sites, ["ebay", "poshmark"]);
  assert.equal(siteArgs.opts.maxPrice, 350, "price is a structured cap, not folded into text");
  assert.equal(run[0].newHits[0].price, 320);
});

test("a brand-new listing shows up as new on a later run", async () => {
  await ss.addSavedSearch({ query: "Chanel flap" });
  await ss.runSavedSearches({ search: async () => [{ title: "A", url: "https://x/1" }] });
  const run = await ss.runSavedSearches({ search: async () => [{ title: "A", url: "https://x/1" }, { title: "B", url: "https://x/2" }] });
  assert.deepEqual(run[0].newHits.map((h) => h.url), ["https://x/2"]);
});

test("formatSavedSearchRun summarizes only searches with new finds", async () => {
  const out = ss.formatSavedSearchRun([
    { label: "Tabis", maxPrice: 350, newHits: [{ title: "Tabi 39", url: "https://v/a" }] },
    { label: "Quiet", maxPrice: null, newHits: [] },
  ]);
  assert.match(out, /Tabis \(under \$350\): 1 new/);
  assert.doesNotMatch(out, /Quiet/);
});
