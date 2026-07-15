import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-resale-feed-test.json");
process.env.RESALE_FEED_HITS_PATH = TMP;
const f = await import("../src/resale-feed.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

// Raw rows as readListingFeed returns them from TheRealReal's grid.
const RAW = [
  { href: "/products/men/clothing/dress-shirts/prada-x", brand: "Prada", description: "Prada Vintage 2000's Dress Shirt", price: "- Price: $245.00" },
  { href: "/products/men/bags/weekenders/bottega-y", brand: "Bottega Veneta", description: "Bottega Veneta Intrecciato Cabat", price: "$2,145.00" },
  { href: "/products/men/clothing/dress-shirts/prada-x", brand: "Prada", description: "dupe", price: "$245.00" }, // duplicate href
];

test("normalizeFeedItems parses price, strips repeated brand, absolutizes url, dedupes", () => {
  const items = f.normalizeFeedItems(RAW);
  assert.equal(items.length, 2); // duplicate href dropped
  assert.deepEqual(items[0], {
    href: "/products/men/clothing/dress-shirts/prada-x",
    url: "https://www.therealreal.com/products/men/clothing/dress-shirts/prada-x",
    brand: "Prada",
    item: "Vintage 2000's Dress Shirt", // leading "Prada " stripped
    price: 245,
  });
  assert.equal(items[1].price, 2145); // comma handled
  assert.equal(items[1].item, "Intrecciato Cabat");
});

test("normalizeFeedItems tolerates missing price / brand", () => {
  const items = f.normalizeFeedItems([{ href: "/products/z", brand: null, description: "Mystery Item", price: null }]);
  assert.equal(items[0].price, null);
  assert.equal(items[0].brand, null);
  assert.equal(items[0].item, "Mystery Item");
});

test("formatFeedItems renders a scannable list and caps with a more-count", () => {
  const items = f.normalizeFeedItems(RAW);
  const out = f.formatFeedItems(items);
  assert.match(out, /Prada Vintage 2000's Dress Shirt \(\$245\)/);
  assert.match(out, /therealreal\.com\/products/);
  assert.equal(f.formatFeedItems([]), "");
  const many = Array.from({ length: 15 }, (_, i) => ({ href: `/products/${i}`, brand: "B", item: `i${i}`, price: i, url: `u${i}` }));
  assert.match(f.formatFeedItems(many, { max: 12 }), /\.\.\.and 3 more/);
});

test("runFirstLookFeed seeds silently on first run, then surfaces only NEW items", async () => {
  const read = async () => ({ items: RAW });
  // First run: store empty -> seed everything, surface nothing (no giant dump).
  let r = await f.runFirstLookFeed({ read, now: () => "t0" });
  assert.equal(r.seeded, true);
  assert.equal(r.newItems.length, 0);
  assert.equal(r.totalFound, 2);

  // Second run, same feed -> nothing new.
  r = await f.runFirstLookFeed({ read, now: () => "t1" });
  assert.equal(r.seeded, false);
  assert.equal(r.newItems.length, 0);

  // A genuinely new arrival appears -> surfaced once.
  const read2 = async () => ({ items: [...RAW, { href: "/products/new-bag", brand: "Hermès", description: "Hermès Birkin", price: "$9,500.00" }] });
  r = await f.runFirstLookFeed({ read: read2, now: () => "t2" });
  assert.deepEqual(r.newItems.map((i) => i.brand), ["Hermès"]);

  // And not again on the next run.
  r = await f.runFirstLookFeed({ read: read2, now: () => "t3" });
  assert.equal(r.newItems.length, 0);
});

test("runFirstLookFeed hones to the hunt list: only arrivals matching a hunt surface", async () => {
  const hunts = [{ query: "Bottega Veneta Cabat" }];
  // Seed silently.
  await f.runFirstLookFeed({ read: async () => ({ items: RAW }), hunts, now: () => "t0" });
  // New arrivals: one matches the hunt, one (Hermès Birkin) does not.
  const read = async () => ({
    items: [
      ...RAW,
      { href: "/products/new-cabat", brand: "Bottega Veneta", description: "Bottega Veneta Intrecciato Cabat Tote", price: "$3,000.00" },
      { href: "/products/new-birkin", brand: "Hermès", description: "Hermès Birkin", price: "$9,500.00" },
    ],
  });
  const r = await f.runFirstLookFeed({ read, hunts, now: () => "t1" });
  assert.deepEqual(r.newItems.map((i) => i.brand), ["Bottega Veneta"], "only the hunted piece surfaces");
  assert.equal(r.totalFound, 4);

  // The un-surfaced Birkin was still RECORDED, so it never resurfaces later (even
  // if the family later widens their hunts).
  const r2 = await f.runFirstLookFeed({ read, hunts: [{ query: "Hermès Birkin" }], now: () => "t2" });
  assert.equal(r2.newItems.length, 0, "a recorded-but-unsurfaced item does not resurface");
});

test("runFirstLookFeed degrades gracefully when the read throws (e.g. not signed in)", async () => {
  const read = async () => { throw new Error("redirected to sign-in"); };
  const r = await f.runFirstLookFeed({ read });
  assert.equal(r.error, true);
  assert.equal(r.newItems.length, 0);
});
