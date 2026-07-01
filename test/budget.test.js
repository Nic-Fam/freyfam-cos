import { test } from "node:test";
import assert from "node:assert";
import { computeBudgetStatus, dailyCumulative, formatBudget, localMonthParts } from "../src/budget.js";
import { budgetChartSvg } from "../src/budget-chart.js";

const NOW = new Date("2026-06-15T12:00:00-07:00"); // June 15 PT; June has 30 days
const TZ = "America/Los_Angeles";
const TXNS = [
  { date: "2026-06-03", amount: 1000, source: "credit" },
  { date: "2026-06-10", amount: 2000, source: "checking" },
  { date: "2026-05-30", amount: 9999, source: "credit" }, // prior month -> ignored
];

test("localMonthParts reads the local month/day/daysInMonth", () => {
  const p = localMonthParts(NOW, TZ);
  assert.equal(p.ym, "2026-06");
  assert.equal(p.day, 15);
  assert.equal(p.daysInMonth, 30);
});

test("dailyCumulative accrues month-to-date spend by day", () => {
  const daily = dailyCumulative(TXNS, { ym: "2026-06", today: 15, daysInMonth: 30 });
  assert.equal(daily.length, 15);
  assert.equal(daily[daily.length - 1].cumulative, 3000); // 1000 + 2000, May txn excluded
  assert.equal(daily.find((d) => d.day === 3).cumulative, 1000);
});

test("computeBudgetStatus folds off-book commitments into consumed + savings math", () => {
  const s = computeBudgetStatus({
    now: NOW, transactions: TXNS, income: 10000, savingsRate: 0.1, offBookMonthly: 249, tz: TZ,
  });
  assert.equal(s.trackedToDate, 3000);
  assert.equal(s.consumedToDate, 3249);       // + $249 off-book (Shelli's loan)
  assert.equal(s.spendCap, 9000);             // income * (1 - 0.1)
  assert.equal(s.savingsTarget, 1000);
  assert.equal(s.pctOfIncome, 32.49);
  assert.equal(s.onPace, true);               // 3249 <= 9000 * (15/30)
  assert.equal(s.projectedSpend, 6249);       // (3000/15)*30 + 249
  assert.equal(s.projectedSavings, 3751);
  assert.equal(s.series[s.series.length - 1].pctOfIncome, 32.49);
});

test("over-pace is flagged when consumed outruns the cap pace", () => {
  const heavy = [{ date: "2026-06-02", amount: 8000, source: "credit" }];
  const s = computeBudgetStatus({ now: NOW, transactions: heavy, income: 10000, savingsRate: 0.1, offBookMonthly: 0, tz: TZ });
  assert.equal(s.onPace, false); // 8000 > 9000 * 0.5
});

test("no income set -> incomeSet false and a clear prompt, no divide-by-zero", () => {
  const s = computeBudgetStatus({ now: NOW, transactions: TXNS, income: 0, tz: TZ });
  assert.equal(s.incomeSet, false);
  assert.equal(s.pctOfIncome, null);
  assert.match(formatBudget(s), /income isn't set/i);
});

test("formatBudget renders the bar, %, cap, and projection when income is set", () => {
  const s = computeBudgetStatus({ now: NOW, transactions: TXNS, income: 10000, savingsRate: 0.1, offBookMonthly: 249, tz: TZ });
  const txt = formatBudget(s);
  assert.match(txt, /32\.49% of income/);
  assert.match(txt, /off-book/);
  assert.match(txt, /save 10%/);
  assert.match(txt, /savings \$3751/);
});

test("budgetChartSvg is empty without income, and draws cap+burn line with income", () => {
  const noIncome = computeBudgetStatus({ now: NOW, transactions: TXNS, income: 0, tz: TZ });
  assert.equal(budgetChartSvg(noIncome), "");

  const s = computeBudgetStatus({ now: NOW, transactions: TXNS, income: 10000, savingsRate: 0.1, offBookMonthly: 249, tz: TZ });
  const svg = budgetChartSvg(s);
  assert.match(svg, /^<svg/);
  assert.match(svg, /spend cap 90%/);   // 100% - 10% savings
  assert.match(svg, /save 10%/);
  assert.match(svg, /<path d="M/);       // the burn line
  assert.match(svg, /Budget burn/);
});
