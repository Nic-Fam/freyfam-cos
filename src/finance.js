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
