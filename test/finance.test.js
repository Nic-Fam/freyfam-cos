import test from "node:test";
import assert from "node:assert";
import { analyzeTransactions } from "../src/finance.js";

test("totals by category and grand total", () => {
  const r = analyzeTransactions([
    { amount: 10, category: "Food" },
    { amount: 5, category: "food" },
    { amount: 20, category: "Toys" },
  ]);
  assert.equal(r.count, 3);
  assert.equal(r.total, 35);
  assert.equal(r.totalsByCategory.food, 15); // case-insensitive merge
  assert.equal(r.totalsByCategory.toys, 20);
});

test("detects duplicate charges (same merchant+amount within window)", () => {
  const r = analyzeTransactions([
    { merchant: "Netflix", amount: 15.99, date: "2026-06-01" },
    { merchant: "netflix", amount: 15.99, date: "2026-06-02" }, // dup of #0
    { merchant: "Netflix", amount: 15.99, date: "2026-07-15" }, // outside 3-day window
  ]);
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].merchant, "Netflix");
});

test("flags notable price jumps vs the merchant median", () => {
  const r = analyzeTransactions([
    { merchant: "Electric", amount: 100 },
    { merchant: "Electric", amount: 110 },
    { merchant: "Electric", amount: 300 }, // >= 1.5x median (110)
  ]);
  assert.equal(r.notable.length, 1);
  assert.equal(r.notable[0].amount, 300);
  assert.equal(r.notable[0].baseline, 110);
});

test("ignores malformed amounts safely", () => {
  const r = analyzeTransactions([{ amount: "x" }, null, undefined, { amount: 5 }]);
  assert.equal(r.count, 1);
  assert.equal(r.total, 5);
});
