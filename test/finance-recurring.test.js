import { test } from "node:test";
import assert from "node:assert";
import { detectRecurring, formatRecurring } from "../src/finance.js";

const NOW = new Date("2026-06-24T00:00:00Z");

test("detectRecurring finds monthly subscriptions and flags a price increase", () => {
  const txns = [
    { merchant: "Netflix", amount: 15.49, date: "2026-04-10" },
    { merchant: "Netflix", amount: 15.49, date: "2026-05-10" },
    { merchant: "Netflix", amount: 17.99, date: "2026-06-10" }, // went up
    { merchant: "Trader Joes", amount: 62.1, date: "2026-06-01" }, // one-off, ignored
  ];
  const r = detectRecurring(txns, { now: NOW });
  const nf = r.find((x) => x.merchant === "Netflix");
  assert.ok(nf, "Netflix detected as recurring");
  assert.equal(nf.cadence, "monthly");
  assert.equal(nf.lastAmount, 17.99);
  assert.equal(nf.priceChange, 2.5); // 17.99 - 15.49
  assert.equal(nf.nextExpected, "2026-07-10");
  assert.ok(!r.find((x) => x.merchant === "Trader Joes"), "single charge is not recurring");
});

test("detectRecurring ignores irregular intervals", () => {
  const txns = [
    { merchant: "Random", amount: 5, date: "2026-01-01" },
    { merchant: "Random", amount: 5, date: "2026-01-09" },
    { merchant: "Random", amount: 5, date: "2026-05-20" },
  ];
  assert.equal(detectRecurring(txns, { now: NOW }).length, 0);
});

test("formatRecurring summarizes due-soon + price changes", () => {
  const out = formatRecurring([
    { merchant: "Netflix", cadence: "monthly", lastAmount: 17.99, nextExpected: "2026-07-10", priceChange: 2.5, daysUntilNext: 3 },
  ]);
  assert.match(out, /Netflix: \$17\.99 monthly/);
  assert.match(out, /in 3d/);
  assert.match(out, /UP \$2\.50/);
  assert.equal(formatRecurring([]), "No recurring charges detected.");
});
