import { test } from "node:test";
import assert from "node:assert";
import { normalizeSiteKey, searchSite, runSiteSearch } from "../src/resale-sources.js";

test("normalizeSiteKey canonicalizes user-entered labels", () => {
  assert.equal(normalizeSiteKey("eBay"), "ebay");
  assert.equal(normalizeSiteKey("www.Poshmark.com"), "poshmark");
  assert.equal(normalizeSiteKey(" Grailed "), "grailed");
});

test("searchSite routes eBay to the API source with a structured maxPrice", async () => {
  let got;
  const ebay = async (q, opts) => { got = { q, opts }; return [{ title: "e", url: "https://ebay/1", price: 10 }]; };
  const out = await searchSite("ebay", "Tabi", { maxPrice: 350, count: 5, ebay });
  assert.equal(out[0].url, "https://ebay/1");
  assert.equal(got.opts.maxPrice, 350);
  assert.equal(got.opts.count, 5);
});

test("searchSite routes a known no-API site to the browser source", async () => {
  let got;
  const browser = async (key, q, opts) => { got = { key, q, opts }; return [{ title: "p", url: "https://posh/1" }]; };
  const out = await searchSite("poshmark", "Tabi", { maxPrice: 200, count: 8, browser });
  assert.equal(got.key, "poshmark");
  assert.equal(got.opts.maxPrice, 200);
  assert.equal(got.opts.max, 8, "count maps to the browser feed's max");
  assert.equal(out[0].url, "https://posh/1");
});

test("searchSite falls back to Brave (domain-scoped, price folded) for sites with no API/browser", async () => {
  let q;
  const braveSearch = async (query) => { q = query; return [{ title: "v", url: "https://vc/1" }]; };
  await searchSite("vestiaire", "Margiela Tabi", { maxPrice: 350, braveSearch });
  assert.match(q, /Margiela Tabi/);
  assert.match(q, /under \$350/);
  assert.match(q, /site:vestiairecollective\.com/);
});

test("runSiteSearch fans across sites and dedupes by url", async () => {
  const ebay = async () => [{ title: "a", url: "https://x/1" }, { title: "b", url: "https://x/2" }];
  const browser = async () => [{ title: "b2", url: "https://x/2" }, { title: "c", url: "https://x/3" }]; // x/2 dup
  const out = await runSiteSearch("Tabi", { sites: ["ebay", "poshmark"], ebay, browser });
  assert.deepEqual(out.map((r) => r.url), ["https://x/1", "https://x/2", "https://x/3"], "merged, x/2 deduped");
});

test("runSiteSearch: one failing site does not sink the others", async () => {
  // vestiaire -> Brave (we inject a throwing braveSearch); ebay -> Brave too only
  // if unknown; here use two Brave-fallback sites, one throws.
  let calls = 0;
  const braveSearch = async (query) => {
    calls++;
    if (query.includes("mytheresa")) throw new Error("brave 429");
    return [{ title: "v", url: "https://vc/1" }];
  };
  const out = await runSiteSearch("Tabi", { sites: ["vestiaire", "mytheresa"], braveSearch });
  assert.deepEqual(out.map((r) => r.url), ["https://vc/1"], "vestiaire result survives mytheresa's failure");
  assert.equal(calls, 2);
});
