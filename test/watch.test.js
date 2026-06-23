import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-watch-test.json");
process.env.WATCH_PATH = TMP;
const w = await import("../src/watch.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("extractPrice pulls the first plausible dollar amount", () => {
  assert.equal(w.extractPrice("Margiela Tabi  $1,295.00  Free shipping"), 1295);
  assert.equal(w.extractPrice("Now $480 (was $650)"), 480);
  assert.equal(w.extractPrice("no price here"), null);
});

test("pickPrice prefers structured signals over visible text, in priority order", () => {
  // JSON-LD wins over everything (the real listing price, e.g. TheRealReal/eBay).
  assert.equal(
    w.pickPrice({ priceSignals: { jsonLd: 245, meta: 999, microdata: 888 }, text: "$12 shipping" }),
    245
  );
  // Falls to meta, then microdata, as each higher signal is absent.
  assert.equal(w.pickPrice({ priceSignals: { jsonLd: null, meta: 459.99, microdata: 888 } }), 459.99);
  assert.equal(w.pickPrice({ priceSignals: { jsonLd: null, meta: null, microdata: 320 } }), 320);
  // No structured signal -> text heuristic last resort.
  assert.equal(w.pickPrice({ priceSignals: { jsonLd: null, meta: null, microdata: null }, text: "Now $480" }), 480);
  // No signals object at all -> text.
  assert.equal(w.pickPrice({ text: "Margiela Tabi $1,295.00" }), 1295);
  // Zero/invalid structured values are ignored, not treated as a price.
  assert.equal(w.pickPrice({ priceSignals: { jsonLd: 0, meta: null, microdata: null }, text: "$75" }), 75);
  assert.equal(w.pickPrice({}), null);
});

test("priceStatus flags a drop and a target hit", () => {
  assert.deepEqual(w.priceStatus(450, { lastPrice: 500, targetPrice: 400 }), { dropped: true, hitTarget: false, delta: -50 });
  assert.deepEqual(w.priceStatus(390, { lastPrice: 500, targetPrice: 400 }), { dropped: true, hitTarget: true, delta: -110 });
  assert.deepEqual(w.priceStatus(500, { lastPrice: 500, targetPrice: 400 }), { dropped: false, hitTarget: false, delta: 0 });
});

test("checkWatched flags only items that dropped / hit target, and records history", async () => {
  await w.watchItem({ url: "https://shop/a", label: "Bag A", targetPrice: 400 });
  await w.watchItem({ url: "https://shop/b", label: "Bag B" });
  // First check establishes a baseline (no drop yet vs null lastPrice).
  const prices = { "https://shop/a": "$500", "https://shop/b": "$200" };
  const read = async (url) => ({ text: prices[url] });
  let flagged = await w.checkWatched({ read, now: () => "t1" });
  assert.equal(flagged.length, 0); // baseline run

  // A drops to 380 (below target 400) -> flagged; B unchanged.
  prices["https://shop/a"] = "$380";
  flagged = await w.checkWatched({ read, now: () => "t2" });
  assert.deepEqual(flagged.map((f) => f.label), ["Bag A"]);
  assert.equal(flagged[0].hitTarget, true);
  const a = (await w.listWatched()).find((i) => i.label === "Bag A");
  assert.equal(a.lastPrice, 380);
  assert.equal(a.history.length, 2);
});
