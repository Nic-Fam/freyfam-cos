import { test } from "node:test";
import assert from "node:assert";
import { reconcile, formatReconciliation } from "../src/reconcile.js";

test("matches by amount, surfaces missing-from-tab and extra-in-tab", () => {
  const tab = [
    { date: "2026-06-02", amount: 50.00, merchant: "Coffee" },
    { date: "2026-06-05", amount: 120.00, merchant: "Gas" },
    { date: "2026-06-20", amount: 9.99, merchant: "App store" }, // not on statement
  ];
  const statement = [
    { date: "2026-06-02", amount: 50.00, merchant: "COFFEE CO" },
    { date: "2026-06-05", amount: 120.00, merchant: "SHELL GAS" },
    { date: "2026-06-12", amount: 84.20, merchant: "AMZN" }, // missing from tab
  ];
  const r = reconcile(tab, statement);
  assert.equal(r.counts.matched, 2);
  assert.equal(r.missingFromTab.length, 1);
  assert.equal(r.missingFromTab[0].amount, 84.20);
  assert.equal(r.extraInTab.length, 1);
  assert.equal(r.extraInTab[0].amount, 9.99);
  assert.equal(r.statementTotal, 254.20);
  assert.equal(r.tabTotal, 179.99);
  assert.equal(r.difference, 74.21);
});

test("matches on absolute amount (sign-convention agnostic)", () => {
  const r = reconcile([{ date: "2026-06-02", amount: 50 }], [{ date: "2026-06-02", amount: -50 }]);
  assert.equal(r.counts.matched, 1);
  assert.equal(r.missingFromTab.length, 0);
});

test("same amount twice: greedy picks the nearest date, both can match", () => {
  const tab = [
    { date: "2026-06-01", amount: 30 },
    { date: "2026-06-15", amount: 30 },
  ];
  const statement = [
    { date: "2026-06-14", amount: 30 },
    { date: "2026-06-02", amount: 30 },
  ];
  const r = reconcile(tab, statement);
  assert.equal(r.counts.matched, 2);
  assert.equal(r.extraInTab.length, 0);
  // the Jun 14 statement line should pair with the Jun 15 tab entry
  const m = r.matched.find((x) => x.statement.date === "2026-06-14");
  assert.equal(m.tab.date, "2026-06-15");
});

test("clean reconciliation reports a tie-out", () => {
  const same = [{ date: "2026-06-01", amount: 10 }, { date: "2026-06-02", amount: 20 }];
  const r = reconcile(same, same);
  assert.equal(r.difference, 0);
  assert.match(formatReconciliation(r, { source: "credit" }), /Clean: every line ties out/);
});

test("formatReconciliation lists the discrepancies", () => {
  const r = reconcile(
    [{ date: "2026-06-20", amount: 9.99, merchant: "App store" }],
    [{ date: "2026-06-12", amount: 84.20, merchant: "AMZN" }]
  );
  const out = formatReconciliation(r, { source: "credit" });
  assert.match(out, /MISSING from the tab/);
  assert.match(out, /84\.20/);
  assert.match(out, /NOT on the statement/);
  assert.match(out, /9\.99/);
});
