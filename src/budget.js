import { BUDGET } from "./config.js";
import { listTransactions } from "./finance-log.js";

// ===========================================================================
// Monthly budget burn. Answers "how much of this month's income have we spent,
// and are we on pace to hit the savings goal?" day-by-day.
//
// consumed = Patrick-visible spend (checking + credit, month-to-date) PLUS known
// off-book fixed commitments (BUDGET.offBookMonthly — e.g. Shelli's student loan,
// paid from an account Patrick can't see) counted as committed for the whole
// month. spend cap = income * (1 - savingsRate); staying under it = hitting the
// savings goal. Pure functions (inject now/transactions/config) so it's testable
// and the chart + tool + digest all read the same numbers.
// ===========================================================================

const round2 = (x) => Math.round(Number(x) * 100) / 100;

// Local {year, month(1-12), day, daysInMonth, ym} for a tz.
export function localMonthParts(now, tz = BUDGET.tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(now).map((x) => [x.type, x.value])
  );
  const year = Number(p.year), month = Number(p.month), day = Number(p.day);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day, daysInMonth, ym: `${p.year}-${p.month}` };
}

/**
 * Cumulative Patrick-visible spend by day-of-month for the given month.
 * Returns [{day, spend, cumulative}] for days 1..(today), from the transaction feed.
 * Pure: pass the transactions.
 */
export function dailyCumulative(transactions = [], { ym, today, daysInMonth }) {
  const perDay = new Array(daysInMonth + 1).fill(0);
  for (const t of transactions) {
    const d = String(t.date || t.at || "");
    if (d.slice(0, 7) !== ym) continue;
    const day = Number(d.slice(8, 10));
    if (day >= 1 && day <= daysInMonth) perDay[day] += Number(t.amount || 0);
  }
  const out = [];
  let run = 0;
  const last = Math.min(today || daysInMonth, daysInMonth);
  for (let day = 1; day <= last; day++) {
    run += perDay[day];
    out.push({ day, spend: round2(perDay[day]), cumulative: round2(run) });
  }
  return out;
}

/**
 * Full budget status for the current month. Pure (inject deps for tests).
 * @returns rich object incl. a day-by-day `series` of {day, cumulative, pctOfIncome}.
 */
export function computeBudgetStatus({
  now = new Date(),
  transactions = [],
  income = BUDGET.monthlyIncome,
  savingsRate = BUDGET.savingsRate,
  offBookMonthly = BUDGET.offBookMonthly,
  tz = BUDGET.tz,
} = {}) {
  const { ym, day, daysInMonth } = localMonthParts(now, tz);
  const daily = dailyCumulative(transactions, { ym, today: day, daysInMonth });
  const trackedToDate = daily.length ? daily[daily.length - 1].cumulative : 0;
  // Off-book fixed commitments are spoken-for the whole month -> a flat floor.
  const consumedToDate = round2(trackedToDate + offBookMonthly);

  const incomeSet = income > 0;
  const spendCap = incomeSet ? round2(income * (1 - savingsRate)) : null;      // stay under this to save
  const savingsTarget = incomeSet ? round2(income * savingsRate) : null;
  const pctOfIncome = incomeSet ? round2((consumedToDate / income) * 100) : null;
  const pctOfCap = incomeSet && spendCap > 0 ? round2((consumedToDate / spendCap) * 100) : null;

  // Pace: fraction of the month elapsed. On pace = consumed <= that fraction of the cap.
  const elapsed = daysInMonth ? day / daysInMonth : 0;
  const onCapPaceLimit = incomeSet ? round2(spendCap * elapsed) : null; // where consumed "should" be to end at the cap
  const onPace = incomeSet ? consumedToDate <= onCapPaceLimit : null;

  // Straight-line projection of the tracked burn to month end, plus the off-book floor.
  const projectedSpend = incomeSet
    ? round2((trackedToDate / Math.max(day, 1)) * daysInMonth + offBookMonthly)
    : null;
  const projectedSavings = incomeSet ? round2(income - projectedSpend) : null;

  const series = daily.map((d) => ({
    day: d.day,
    cumulative: round2(d.cumulative + offBookMonthly),
    pctOfIncome: incomeSet ? round2(((d.cumulative + offBookMonthly) / income) * 100) : null,
  }));

  return {
    ym, day, daysInMonth, incomeSet,
    income, savingsRate, offBookMonthly,
    trackedToDate, consumedToDate,
    spendCap, savingsTarget,
    pctOfIncome, pctOfCap, onPace, onCapPaceLimit,
    projectedSpend, projectedSavings,
    series,
  };
}

/** Convenience: pull the month's transactions and compute status. */
export async function budgetStatus({ now = new Date(), cfg = BUDGET } = {}) {
  const { ym } = localMonthParts(now, cfg.tz);
  const all = await listTransactions({});
  const txns = all.filter((t) => String(t.date || t.at || "").slice(0, 7) === ym);
  return computeBudgetStatus({
    now, transactions: txns,
    income: cfg.monthlyIncome, savingsRate: cfg.savingsRate, offBookMonthly: cfg.offBookMonthly, tz: cfg.tz,
  });
}

const bar = (pct, width = 20) => {
  const p = Math.max(0, Math.min(pct ?? 0, 100));
  const filled = Math.round((p / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(Math.max(0, width - filled))}]`;
};

/** One-liner / text summary for the on-demand tool and the daily digest line. */
export function formatBudget(s) {
  if (!s.incomeSet) {
    return "Budget: monthly income isn't set yet. Set BUDGET_MONTHLY_INCOME so I can track spend as a % of income.";
  }
  const off = s.offBookMonthly ? ` (incl. $${s.offBookMonthly.toFixed(2)} off-book)` : "";
  const pace = s.onPace ? "on pace to save" : "over pace — trending past the cap";
  return [
    `Budget, ${s.ym} (day ${s.day}/${s.daysInMonth}):`,
    `${bar(s.pctOfIncome)} ${s.pctOfIncome}% of income spent${off}.`,
    `$${s.consumedToDate.toFixed(2)} of $${s.income.toFixed(2)}; cap $${s.spendCap.toFixed(2)} (save ${Math.round(s.savingsRate * 100)}%).`,
    `${pace}. Projected month-end spend $${s.projectedSpend.toFixed(2)} → savings $${s.projectedSavings.toFixed(2)}.`,
  ].join("\n");
}
