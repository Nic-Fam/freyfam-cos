// Pure spending analysis for the finance specialist's `analyze_transactions` tool.
// No external services: it operates only on the transactions handed to it, so it
// is deterministic and fully unit-testable. The persona's job is to "flag
// duplicate charges, price jumps, and renewals worth reviewing" — that is exactly
// what this returns. It never moves money (hard constraint #3).

const round2 = (x) => Math.round(x * 100) / 100;
const norm = (s) => String(s || "").trim().toLowerCase();

function withinDays(d1, d2, n) {
  const a = Date.parse(d1), b = Date.parse(d2);
  if (Number.isNaN(a) || Number.isNaN(b)) return true; // no usable dates -> don't gate on time
  return Math.abs(a - b) <= n * 24 * 60 * 60 * 1000;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * @param {Array<{date?:string, amount:number, merchant?:string, category?:string}>} transactions
 * @param {{jumpFactor?:number, dupWindowDays?:number}} [opts]
 * @returns {{count:number, total:number, totalsByCategory:object, duplicates:Array, notable:Array}}
 */
export function analyzeTransactions(transactions = [], { jumpFactor = 1.5, dupWindowDays = 3 } = {}) {
  const txns = (Array.isArray(transactions) ? transactions : []).filter(
    (t) => t && typeof t.amount === "number" && Number.isFinite(t.amount)
  );

  const totalsByCategory = {};
  let total = 0;
  for (const t of txns) {
    const cat = norm(t.category) || "uncategorized";
    totalsByCategory[cat] = round2((totalsByCategory[cat] || 0) + t.amount);
    total = round2(total + t.amount);
  }

  // Duplicate charges: same merchant + same amount within the window.
  const duplicates = [];
  for (let i = 0; i < txns.length; i++) {
    for (let j = i + 1; j < txns.length; j++) {
      const a = txns[i], b = txns[j];
      if (norm(a.merchant) && norm(a.merchant) === norm(b.merchant) &&
          a.amount === b.amount && withinDays(a.date, b.date, dupWindowDays)) {
        duplicates.push({ merchant: a.merchant, amount: a.amount, dates: [a.date, b.date].filter(Boolean) });
      }
    }
  }

  // Notable price jumps: per merchant with 2+ charges, flag any charge that is
  // >= jumpFactor x the merchant's median (and strictly above it).
  const byMerchant = {};
  for (const t of txns) {
    const m = norm(t.merchant);
    if (m) (byMerchant[m] ||= []).push(t);
  }
  const notable = [];
  for (const list of Object.values(byMerchant)) {
    if (list.length < 2) continue;
    const med = median(list.map((t) => t.amount));
    if (med <= 0) continue;
    for (const t of list) {
      if (t.amount >= jumpFactor * med && t.amount > med) {
        notable.push({ merchant: t.merchant, amount: t.amount, baseline: med, date: t.date });
      }
    }
  }

  return { count: txns.length, total, totalsByCategory, duplicates, notable };
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Recurring-charge / subscription radar (surfacing only; never moves money). Groups
 * by merchant, finds those billed at a regular cadence (weekly/monthly/yearly), and
 * flags the next expected charge + any price change vs the prior charge. Use it to
 * answer "what subscriptions renew soon / which one went up". Pure + testable.
 * @returns {Array<{merchant, cadence, intervalDays, lastAmount, lastDate, nextExpected, priceChange}>}
 */
export function detectRecurring(transactions = [], { now = new Date(), toleranceDays = 5 } = {}) {
  const byMerchant = {};
  for (const t of transactions || []) {
    if (!t || typeof t.amount !== "number" || !t.date || Number.isNaN(Date.parse(t.date))) continue;
    (byMerchant[norm(t.merchant)] ||= []).push({ amount: t.amount, at: Date.parse(t.date), merchant: t.merchant, date: t.date });
  }
  const CADENCES = [
    { name: "weekly", days: 7 }, { name: "monthly", days: 30 }, { name: "yearly", days: 365 },
  ];
  const out = [];
  for (const charges of Object.values(byMerchant)) {
    if (charges.length < 2) continue; // need a pattern
    charges.sort((a, b) => a.at - b.at);
    const gaps = charges.slice(1).map((c, i) => (c.at - charges[i].at) / DAY);
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const cadence = CADENCES.find((c) => Math.abs(avgGap - c.days) <= toleranceDays);
    if (!cadence) continue; // not a regular interval
    const last = charges[charges.length - 1];
    const prev = charges[charges.length - 2];
    out.push({
      merchant: last.merchant,
      cadence: cadence.name,
      intervalDays: Math.round(avgGap),
      lastAmount: round2(last.amount),
      lastDate: last.date,
      nextExpected: new Date(last.at + cadence.days * DAY).toISOString().slice(0, 10),
      priceChange: prev.amount !== last.amount ? round2(last.amount - prev.amount) : 0,
      daysUntilNext: Math.round((last.at + cadence.days * DAY - now.getTime()) / DAY),
    });
  }
  return out.sort((a, b) => a.daysUntilNext - b.daysUntilNext);
}

/** Human summary for the finance specialist's reply. Pure. */
export function formatRecurring(recurring = []) {
  if (!recurring.length) return "No recurring charges detected.";
  return recurring
    .map((r) => {
      const due = r.daysUntilNext <= 0 ? "due now" : `in ${r.daysUntilNext}d (${r.nextExpected})`;
      const chg = r.priceChange > 0 ? ` — UP $${r.priceChange.toFixed(2)}` : r.priceChange < 0 ? ` — down $${Math.abs(r.priceChange).toFixed(2)}` : "";
      return `- ${r.merchant}: $${r.lastAmount.toFixed(2)} ${r.cadence}, next ${due}${chg}`;
    })
    .join("\n");
}
