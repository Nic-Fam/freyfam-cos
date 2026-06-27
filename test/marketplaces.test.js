import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-marketplace-hits-test.json");
process.env.MARKETPLACE_HITS_PATH = TMP;
const m = await import("../src/marketplaces.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("resolveMarketplace maps free-text site labels to a registry key", () => {
  assert.equal(m.resolveMarketplace("eBay"), "ebay");
  assert.equal(m.resolveMarketplace("Vestiaire Collective"), "vestiaire");
  assert.equal(m.resolveMarketplace("1st Dibs"), "1stdibs");
  assert.equal(m.resolveMarketplace("posh"), "poshmark");
  assert.equal(m.resolveMarketplace("The RealReal"), null); // First Look has its own feed
  assert.equal(m.resolveMarketplace("craigslist"), null);
});

test("each registered marketplace builds a newest-first search url and has an anchor", () => {
  for (const key of m.listMarketplaces()) {
    const cfg = m._MARKETS[key];
    const url = cfg.url("gucci loafers", { maxPrice: 300 });
    assert.match(url, /^https:\/\//);
    assert.match(url, /gucci/);
    assert.ok(cfg.anchorPrefix || cfg.anchorMatch, `${key} needs an anchorPrefix or anchorMatch`);
  }
  // eBay applies maxPrice server-side.
  assert.match(m._MARKETS.ebay.url("x", { maxPrice: 250 }), /_udhi=250/);
});

test("normalizeMarketItems absolutizes urls, parses price, dedupes, drops junk", () => {
  const items = m.normalizeMarketItems("ebay", [
    { href: "/itm/111", title: "Gucci Loafers sz 9", price: "$245.00" },
    { href: "/itm/222", title: "Vintage Coat", price: "$1,200.50" },
    { href: "/itm/111", title: "dupe", price: "$245.00" }, // duplicate href
    { href: "/itm/333", title: "Shop on eBay", price: "$20.00" }, // placeholder
    { href: "/itm/444", title: "", price: "$5.00" }, // no title
  ]);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { href: "/itm/111", url: "https://www.ebay.com/itm/111", title: "Gucci Loafers sz 9", price: 245 });
  assert.equal(items[1].price, 1200.5); // comma handled
});

test("normalizeMarketItems keeps absolute hrefs and tolerates a missing price", () => {
  const items = m.normalizeMarketItems("poshmark", [
    { href: "https://poshmark.com/listing/abc", title: "Bag", price: null },
  ]);
  assert.equal(items[0].url, "https://poshmark.com/listing/abc");
  assert.equal(items[0].price, null);
});

const search = { id: "s1", label: "Gucci loafers", query: "gucci loafers", maxPrice: 300, sites: ["ebay", "poshmark"] };

test("runMarketplaceFeeds seeds a (search,site) pair silently, then surfaces only NEW items", async () => {
  const grid = {
    ebay: [{ href: "/itm/1", title: "Gucci A", price: "$200" }, { href: "/itm/2", title: "Gucci B", price: "$250" }],
    poshmark: [{ href: "/listing/p1", title: "Gucci P", price: "$180" }],
  };
  const read = async (url) => ({ items: /ebay/.test(url) ? grid.ebay : grid.poshmark });

  // First run: every pair is new -> seed silently, surface nothing.
  let runs = await m.runMarketplaceFeeds({ searches: [search], read });
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.seeded && r.newItems.length === 0));
  assert.equal(runs.find((r) => r.site === "ebay").totalFound, 2);

  // Second run, same grids -> nothing new.
  runs = await m.runMarketplaceFeeds({ searches: [search], read });
  assert.ok(runs.every((r) => r.newItems.length === 0 && !r.seeded));

  // A new eBay listing appears -> surfaced once, only for eBay.
  grid.ebay.push({ href: "/itm/3", title: "Gucci C", price: "$220" });
  runs = await m.runMarketplaceFeeds({ searches: [search], read });
  const ebay = runs.find((r) => r.site === "ebay");
  assert.deepEqual(ebay.newItems.map((i) => i.title), ["Gucci C"]);
  assert.equal(runs.find((r) => r.site === "poshmark").newItems.length, 0);

  // Not again next run.
  runs = await m.runMarketplaceFeeds({ searches: [search], read });
  assert.ok(runs.every((r) => r.newItems.length === 0));
});

test("runMarketplaceFeeds drops over-budget items and skips unsupported sites", async () => {
  const cheapSearch = { id: "s2", label: "watch", query: "watch", maxPrice: 100, sites: ["ebay", "therealreal"] };
  const read = async () => ({ items: [
    { href: "/itm/a", title: "Cheap watch", price: "$80" },
    { href: "/itm/b", title: "Pricey watch", price: "$500" },
  ] });
  // Seed run (silent) then a run that should expose only the in-budget NEW item.
  await m.runMarketplaceFeeds({ searches: [cheapSearch], read });
  // Both seeded items respected the budget filter, so only the $80 was recorded;
  // add a new in-budget item and confirm the $500 never surfaces.
  const read2 = async () => ({ items: [
    { href: "/itm/a", title: "Cheap watch", price: "$80" },
    { href: "/itm/b", title: "Pricey watch", price: "$500" },
    { href: "/itm/c", title: "Another cheap watch", price: "$95" },
  ] });
  const runs = await m.runMarketplaceFeeds({ searches: [cheapSearch], read: read2 });
  // therealreal is unsupported here, so only one pair (ebay) ran.
  assert.equal(runs.length, 1);
  assert.equal(runs[0].site, "ebay");
  assert.deepEqual(runs[0].newItems.map((i) => i.title), ["Another cheap watch"]);
});

test("runMarketplaceFeeds isolates a failing pair and still runs the rest", async () => {
  const read = async (url) => {
    if (/ebay/.test(url)) throw new Error("sign-in wall");
    return { items: [{ href: "/listing/ok", title: "Poshmark find", price: "$50" }] };
  };
  const runs = await m.runMarketplaceFeeds({ searches: [search], read });
  assert.equal(runs.find((r) => r.site === "ebay").error, true);
  assert.equal(runs.find((r) => r.site === "poshmark").error, false);
});

test("formatMarketRun renders only pairs with new finds, capping with a more-count", () => {
  assert.equal(m.formatMarketRun([]), "");
  assert.equal(m.formatMarketRun([{ label: "x", siteName: "eBay", newItems: [] }]), "");
  const many = Array.from({ length: 10 }, (_, i) => ({ title: `Item ${i}`, price: i, url: `https://e/${i}` }));
  const out = m.formatMarketRun([{ label: "Gucci", siteName: "eBay", newItems: many }], { max: 8 });
  assert.match(out, /Gucci on eBay: 10 new/);
  assert.match(out, /Item 0 \(\$0\)/);
  assert.match(out, /\.\.\.and 2 more/);
});
