import { test } from "node:test";
import assert from "node:assert";
import { judgeListings, buildJudgePrompt } from "../src/hunt-judge.js";
import { runSavedSearches } from "../src/saved-searches.js";
import { normalizeBrowserRows, RESALE_SITES, isBrowserSite } from "../src/resale-browser.js";

const HUNTS = [{ id: "h1", query: "Dsquared2 feather top", maxPrice: 400 }];
const items = [
  { url: "https://poshmark.com/listing/Dsquared2-Feather-Trim-Top-1", text: "DSQUARED2 feather trim silk top Size S $180" },
  { url: "https://poshmark.com/listing/Prosperina-Cocktail-Top-2", text: "Prosperina cocktail top with feather edge $40" },
  { url: "https://poshmark.com/listing/Dsquared2-Feather-Top-3", text: "Dsquared2 feather bustier top $900" },
];
const reply = (results) => async () => ({ content: [{ type: "text", text: JSON.stringify({ results }) }] });

test("judge keeps the real piece, drops lookalikes and over-cap prices, and caches verdicts", async () => {
  const cache = {};
  let calls = 0;
  const llm = async (req) => {
    calls += 1;
    return reply([{ l: 1, h: 1, title: "Dsquared2 Feather Trim Top", price: 180 }, { l: 2, h: 0 }, { l: 3, h: 1, title: "Dsquared2 Feather Bustier", price: 900 }])(req);
  };
  const out = await judgeListings({ hunts: HUNTS, items, llm, cache });
  assert.deepEqual(out.map((o) => o.title), ["Dsquared2 Feather Trim Top"]);
  assert.equal(out[0].price, 180);
  assert.equal(Object.keys(cache).length, 3);

  const again = await judgeListings({ hunts: HUNTS, items, llm, cache });
  assert.equal(calls, 1, "cached verdicts are not re-judged");
  assert.equal(again.length, 1);
});

test("judge falls back to the keyword match when the model fails, without caching", async () => {
  const cache = {};
  const out = await judgeListings({ hunts: HUNTS, items, llm: async () => { throw new Error("down"); }, cache });
  assert.equal(out.length, 3); // keyword bar lets all three through, as before
  assert.equal(Object.keys(cache).length, 0);
});

test("judge prompt names the hunts and the card text", () => {
  const p = buildJudgePrompt(HUNTS, items.slice(0, 1));
  assert.match(p, /H1: Dsquared2 feather top, under \$400/);
  assert.match(p, /L1: DSQUARED2 feather trim silk top/);
});

test("runSavedSearches hones with the judge on unseen results only", async () => {
  process.env.SAVED_SEARCH_HITS_PATH = `/tmp/cos-judge-hits-${process.pid}.json`;
  const runSites = async () => items.map((i) => ({ title: i.url, url: i.url, text: i.text, price: null }));
  let judged = 0;
  const judge = async ({ items: cand }) => { judged += cand.length; return cand.filter((c) => c.url.endsWith("-1")).map((c) => ({ ...c, title: "Dsquared2 Feather Trim Top", price: 180 })); };
  const searches = [{ id: "h1", label: "Dsquared2 feather top", query: "Dsquared2 feather top", sites: ["poshmark"] }];
  const [first] = await runSavedSearches({ searches, runSites, hone: true, judge });
  assert.deepEqual(first.newHits.map((h) => h.title), ["Dsquared2 Feather Trim Top"]);
  assert.equal(first.totalFound, 3);
  const [second] = await runSavedSearches({ searches, runSites, hone: true, judge });
  assert.equal(second.newHits.length, 0);
  assert.equal(judged, 3 + 2, "the surfaced hit is not judged again");
});

test("card text supplies the price when the selector misses; Vestiaire is a browser site", () => {
  const [row] = normalizeBrowserRows([{ href: "/listing/x-1", text: "Dsquared2 top Size M $1,250.00" }], { base: "https://poshmark.com" });
  assert.equal(row.price, 1250);
  assert.equal(row.text, "Dsquared2 top Size M $1,250.00");
  assert.equal(isBrowserSite("vestiaire"), true);
  assert.ok(new RegExp(RESALE_SITES.vestiaire.anchorMatch).test("/women-clothing/tops/dsquared2/top-61234567.shtml"));
});
