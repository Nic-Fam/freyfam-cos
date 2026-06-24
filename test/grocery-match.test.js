import { test } from "node:test";
import assert from "node:assert";
import { tokenize, scoreMatch, matchItemToHistory, resolveAgainstHistory, formatResolution } from "../src/grocery-match.js";
import { resolveGroceryOrder } from "../src/grocery.js";

const HISTORY = [
  { name: "Simple Truth Organic Oat Milk", frequency: 9, lastBought: "2026-06-10" },
  { name: "Kroger 2% Reduced Fat Milk Gallon", frequency: 12, lastBought: "2026-06-18" },
  { name: "Bounty Select-A-Size Paper Towels, 12 Rolls", frequency: 4 },
  { name: "Kroger Grade A Large Eggs, 18 ct", frequency: 7 },
  { name: "Oreo Original Chocolate Sandwich Cookies", frequency: 2 },
];

test("tokenize drops stopwords/units and rough-singularizes", () => {
  assert.deepEqual(tokenize("Eggs, 18 ct"), ["egg"]);
  assert.deepEqual(tokenize("Paper Towels (12 pack)"), ["paper", "towel"]);
});

test("scoreMatch covers the request's words; unrelated products score 0", () => {
  assert.ok(scoreMatch("oat milk", "Simple Truth Organic Oat Milk") >= 1);
  assert.ok(scoreMatch("paper towels", "Bounty Select-A-Size Paper Towels, 12 Rolls") >= 1);
  assert.equal(scoreMatch("milk", "Oreo Original Chocolate Sandwich Cookies"), 0);
});

test("matchItemToHistory picks the exact product the family buys", () => {
  assert.equal(matchItemToHistory("oat milk", HISTORY).matched.name, "Simple Truth Organic Oat Milk");
  assert.equal(matchItemToHistory("eggs", HISTORY).matched.name, "Kroger Grade A Large Eggs, 18 ct");
  assert.equal(matchItemToHistory("paper towels", HISTORY).matched.name, "Bounty Select-A-Size Paper Towels, 12 Rolls");
});

test("a bare 'milk' matches multiple milks -> highest-frequency one wins, frequency disambiguates", () => {
  const r = matchItemToHistory("milk", HISTORY);
  // both milks cover "milk" (score 1.0); 2% is bought more often, so it confidently wins
  assert.equal(r.matched.name, "Kroger 2% Reduced Fat Milk Gallon");
  assert.equal(r.ambiguous, false);
});

test("a true tie (same score AND frequency) IS flagged ambiguous", () => {
  const tied = [
    { name: "Whole Milk Gallon", frequency: 5 },
    { name: "Oat Milk Half Gallon", frequency: 5 },
  ];
  const r = matchItemToHistory("milk", tied);
  assert.ok(r.matched); // still picks one
  assert.equal(r.ambiguous, true); // but flags it so the approval prompt can ask
});

test("no confident match returns matched:null (falls back to free-text)", () => {
  const r = matchItemToHistory("birthday candles", HISTORY);
  assert.equal(r.matched, null);
});

test("formatResolution lists matches + flags unmatched", () => {
  const res = resolveAgainstHistory(["oat milk", "birthday candles"], HISTORY);
  const out = formatResolution(res);
  assert.match(out, /oat milk -> Simple Truth Organic Oat Milk/);
  assert.match(out, /Not found in your purchase history.*birthday candles/);
});

test("resolveGroceryOrder turns requests into order-ready items (matched product or free-text)", async () => {
  const { orderItems } = await resolveGroceryOrder({
    items: [{ item: "oat milk", quantity: 2 }, { item: "birthday candles" }],
    history: HISTORY,
  });
  assert.deepEqual(orderItems[0], { item: "Simple Truth Organic Oat Milk", requested: "oat milk", matched: true, quantity: 2, note: undefined });
  assert.deepEqual(orderItems[1], { item: "birthday candles", requested: "birthday candles", matched: false, quantity: undefined, note: undefined });
});

test("resolveGroceryOrder with no history falls back entirely to free-text (Phase-1 behavior)", async () => {
  const { orderItems, history } = await resolveGroceryOrder({ items: [{ item: "milk" }], history: [] });
  assert.equal(history.length, 0);
  assert.equal(orderItems[0].item, "milk");
  assert.equal(orderItems[0].matched, false);
});
