import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-boutique-hits-test.json");
process.env.BOUTIQUE_FEED_HITS_PATH = TMP;
const { slugToName, canonicalHref, normalizeBoutiqueItems, formatBoutiqueFeed, runBoutiqueFeeds } = await import("../src/boutique-feed.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("slugToName makes a readable name from a /products/ handle", () => {
  assert.equal(slugToName("/products/dsquared2-fw2014-feather-top"), "Dsquared2 Fw2014 Feather Top");
  assert.equal(slugToName("/collections/x"), null);
});

test("normalizeBoutiqueItems dedupes by href and absolutizes urls", () => {
  const out = normalizeBoutiqueItems(
    [{ href: "/products/a" }, { href: "/products/a" }, { href: "https://x.com/products/b", title: "B Coat" }],
    "https://shop.com"
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].url, "https://shop.com/products/a");
  assert.equal(out[1].url, "https://x.com/products/b");
  assert.equal(out[1].name, "B Coat");
});

test("canonicalHref strips Shopify's volatile _pos/_sid/_ss params (relative + absolute)", () => {
  assert.equal(canonicalHref("/products/dsquared2-little-nude-dress?_pos=1&_sid=4fbd367bc&_ss=r"), "/products/dsquared2-little-nude-dress");
  assert.equal(canonicalHref("https://allisonsarchive.shop/products/x?_pos=2&_sid=ZZ&_ss=r"), "https://allisonsarchive.shop/products/x");
  assert.equal(canonicalHref("/products/x#frag"), "/products/x");
});

test("normalizeBoutiqueItems collapses the SAME product carrying different session params", () => {
  const out = normalizeBoutiqueItems(
    [
      { href: "/products/dress?_pos=1&_sid=AAA&_ss=r" },
      { href: "/products/dress?_pos=3&_sid=BBB&_ss=r" }, // same dress, new session id + position
    ],
    "https://allisonsarchive.shop"
  );
  assert.equal(out.length, 1, "one product, not two");
  assert.equal(out[0].url, "https://allisonsarchive.shop/products/dress", "display url has no tracking params");
});

test("runBoutiqueFeeds does NOT re-surface a seen item whose only change is session params (the repeat-dress bug)", async () => {
  const B = [{ name: "Allison's Archive", url: "https://allisonsarchive.shop/search?q=dsquared" }];
  // Seed run records the dress under a session id.
  const seed = await runBoutiqueFeeds({ read: async () => ({ items: [{ href: "/products/dsquared-nude-dress?_pos=1&_sid=AAA&_ss=r" }] }), boutiques: B });
  assert.equal(seed[0].seeded, true);
  // Next run: SAME dress, different _sid/_pos. Pre-fix this re-alerted every run.
  const run2 = await runBoutiqueFeeds({ read: async () => ({ items: [{ href: "/products/dsquared-nude-dress?_pos=4&_sid=BBB&_ss=r" }] }), boutiques: B });
  assert.equal(run2[0].newItems.length, 0, "an already-seen dress must not resurface just because its session id changed");
});

test("first run per boutique seeds silently; new items surface only afterward", async () => {
  const B = [{ name: "Allison's Archive", url: "https://allisonsarchive.shop/search?q=dsquared" }];
  const read1 = async () => ({ items: [{ href: "/products/one" }, { href: "/products/two" }] });
  const seed = await runBoutiqueFeeds({ read: read1, boutiques: B });
  assert.equal(seed[0].seeded, true);
  assert.equal(seed[0].newItems.length, 0, "first run surfaces nothing (seeds)");
  assert.equal(seed[0].totalFound, 2);

  // second run: one repeat, one genuinely new -> only the new one surfaces
  const read2 = async () => ({ items: [{ href: "/products/two" }, { href: "/products/three" }] });
  const run2 = await runBoutiqueFeeds({ read: read2, boutiques: B });
  assert.equal(run2[0].seeded, false);
  assert.deepEqual(run2[0].newItems.map((i) => i.href), ["/products/three"]);
});

test("a boutique whose read throws degrades to error, never crashes", async () => {
  const B = [{ name: "LAL Vintage", url: "https://lalvintage.com/search?q=dsquared" }];
  const res = await runBoutiqueFeeds({ read: async () => { throw new Error("navigation timeout"); }, boutiques: B });
  assert.equal(res[0].error, true);
  assert.equal(res[0].newItems.length, 0);
});

test("formatBoutiqueFeed lists shops with new items, skips empty ones", () => {
  const out = formatBoutiqueFeed([
    { name: "Allison's Archive", newItems: [{ name: "Dsquared2 Feather Top", url: "https://a/products/x" }] },
    { name: "LAL Vintage", newItems: [] },
  ]);
  assert.match(out, /Allison's Archive:/);
  assert.match(out, /Dsquared2 Feather Top/);
  assert.doesNotMatch(out, /LAL Vintage/);
});
