import { test } from "node:test";
import assert from "node:assert";
import { slugToTitle, normalizeBrowserRows, isBrowserSite, browserSiteSearch } from "../src/resale-browser.js";

test("isBrowserSite knows the configured no-API sites", () => {
  assert.equal(isBrowserSite("poshmark"), true);
  assert.equal(isBrowserSite("grailed"), true);
  assert.equal(isBrowserSite("therealreal"), true);
  assert.equal(isBrowserSite("vestiaire"), false, "no clean prefix -> not a browser site (Brave fallback)");
  assert.equal(isBrowserSite("ebay"), false, "eBay uses the API source");
});

test("slugToTitle derives a readable name from a listing URL", () => {
  assert.equal(slugToTitle("/listing/64f-Nike-Air-Max-90"), "Nike Air Max 90");
  assert.equal(slugToTitle("https://www.grailed.com/listings/123-margiela-tabi/"), "margiela tabi");
  assert.equal(slugToTitle("/products/some_user-cool_jacket?ref=x"), "some user cool jacket");
});

test("normalizeBrowserRows: dedup, price parse, absolute url, title fallback", () => {
  const rows = [
    { href: "/listing/1-Tabi-39", title: "Margiela Tabi 39", price: "$320" },
    { href: "/listing/1-Tabi-39", title: "dupe" },                 // duplicate href dropped
    { href: "/listing/2-Tabi-40", price: "$1,200.00" },            // no title -> slug fallback
  ];
  const out = normalizeBrowserRows(rows, { base: "https://poshmark.com" });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { title: "Margiela Tabi 39", url: "https://poshmark.com/listing/1-Tabi-39", snippet: "$320", price: 320 });
  assert.equal(out[1].title, "Tabi 40", "title falls back to the URL slug");
  assert.equal(out[1].price, 1200);
});

test("normalizeBrowserRows drops items known to be over maxPrice, keeps unknown-price ones", () => {
  const rows = [
    { href: "/listing/a", price: "$500" },   // over
    { href: "/listing/b", price: "$200" },   // under
    { href: "/listing/c" },                   // unknown price -> kept
  ];
  const out = normalizeBrowserRows(rows, { base: "https://x", maxPrice: 350 });
  assert.deepEqual(out.map((r) => r.url), ["https://x/listing/b", "https://x/listing/c"]);
});

test("browserSiteSearch normalizes injected feed rows", async () => {
  const read = async (url, opts) => {
    assert.match(url, /poshmark\.com\/search\?query=Margiela%20Tabi/);
    assert.equal(opts.anchorPrefix, "/listing/");
    return { items: [{ href: "/listing/1-Tabi", title: "Tabi", price: "$300" }] };
  };
  const out = await browserSiteSearch("poshmark", "Margiela Tabi", { maxPrice: 350, read });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://poshmark.com/listing/1-Tabi");
});

test("browserSiteSearch returns [] on a read failure (sign-in wall etc.)", async () => {
  const read = async () => { throw new Error("nav timeout"); };
  assert.deepEqual(await browserSiteSearch("grailed", "x", { read }), []);
});

test("browserSiteSearch returns [] for an unconfigured site", async () => {
  assert.deepEqual(await browserSiteSearch("vestiaire", "x", { read: async () => ({ items: [{ href: "/a" }] }) }), []);
});
