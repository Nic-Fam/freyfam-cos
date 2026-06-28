// Statement reconciliation for the finance specialist (Patrick). Patrick keeps a
// RUNNING TAB of checking + credit transactions as alerts come in (finance-log.js);
// at month end the family sends the official statement and Patrick reconciles it
// against the tab to catch anything the tab missed, anything on the tab that is not
// on the statement, and any amount that does not line up.
//
// Pure + deterministic (fully unit-testable): the matching is plain arithmetic over
// the two lists, no model and no external service. Surfacing only - it never moves
// money (hard constraint #3); it tells a human what to look at.
//
// SIGN CONVENTION: both sides should use the same sign for an outflow (we match on
// the absolute amount, so a $50 charge logged as 50 matches a statement line of 50
// or -50). A refund and a charge of the same size could mis-match; that is a rare
// edge a human catches on the surfaced list.

const round2 = (x) => Math.round(Number(x) * 100) / 100;
const amt = (x) => round2(Math.abs(Number(x)));
const norm = (s) => String(s || "").trim().toLowerCase();

function parseable(d) {
  return d && !Number.isNaN(Date.parse(String(d)));
}
function dateDistDays(a, b) {
  if (!parseable(a) || !parseable(b)) return Infinity;
  return Math.abs(Date.parse(String(a)) - Date.parse(String(b))) / 86400000;
}

/**
 * Reconcile the running tab against the official statement lines.
 * Matches greedily: for each statement line, the closest-dated unused tab entry of
 * the same (absolute) amount. Merchant similarity breaks ties.
 * @param {Array<{date?:string, amount:number, merchant?:string}>} tab
 * @param {Array<{date?:string, amount:number, merchant?:string}>} statement
 * @returns {{matched:Array, missingFromTab:Array, extraInTab:Array,
 *            statementTotal:number, tabTotal:number, difference:number, counts:object}}
 */
export function reconcile(tab = [], statement = [], { dateWindowDays = 5 } = {}) {
  const tabItems = (Array.isArray(tab) ? tab : [])
    .filter((t) => t && t.amount != null && Number.isFinite(Number(t.amount)))
    .map((t, i) => ({ ...t, _i: i, _amt: amt(t.amount) }));
  const stmtItems = (Array.isArray(statement) ? statement : [])
    .filter((s) => s && s.amount != null && Number.isFinite(Number(s.amount)))
    .map((s, i) => ({ ...s, _i: i, _amt: amt(s.amount) }));

  const used = new Set();
  const matched = [];
  const missingFromTab = []; // on the statement, not on the tab
  for (const s of stmtItems) {
    let cands = tabItems.filter((t) => !used.has(t._i) && t._amt === s._amt);
    if (!cands.length) { missingFromTab.push(s); continue; }
    cands.sort((a, b) => {
      const dd = dateDistDays(a.date, s.date) - dateDistDays(b.date, s.date);
      if (dd !== 0) return dd;
      // tie-break: prefer a merchant-name overlap
      const am = norm(a.merchant) && norm(s.merchant) && (norm(a.merchant).includes(norm(s.merchant)) || norm(s.merchant).includes(norm(a.merchant))) ? -1 : 0;
      const bm = norm(b.merchant) && norm(s.merchant) && (norm(b.merchant).includes(norm(s.merchant)) || norm(s.merchant).includes(norm(b.merchant))) ? -1 : 0;
      return am - bm;
    });
    const pick = cands[0];
    used.add(pick._i);
    matched.push({ statement: s, tab: pick, dateGapDays: parseable(pick.date) && parseable(s.date) ? Math.round(dateDistDays(pick.date, s.date)) : null });
  }
  const extraInTab = tabItems.filter((t) => !used.has(t._i)); // on the tab, not on the statement
  const statementTotal = round2(stmtItems.reduce((a, s) => a + s._amt, 0));
  const tabTotal = round2(tabItems.reduce((a, t) => a + t._amt, 0));
  return {
    matched,
    missingFromTab,
    extraInTab,
    statementTotal,
    tabTotal,
    difference: round2(statementTotal - tabTotal),
    counts: {
      statement: stmtItems.length,
      tab: tabItems.length,
      matched: matched.length,
      missingFromTab: missingFromTab.length,
      extraInTab: extraInTab.length,
    },
  };
}

const money = (n) => "$" + round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const line = (t) => `${t.date || "?"}  ${money(t.amount)}${t.merchant ? `  ${t.merchant}` : ""}`;

/** Human reconciliation summary for Patrick's reply. Pure. */
export function formatReconciliation(r, { source = "" } = {}) {
  if (!r) return "Nothing to reconcile.";
  const { counts, statementTotal, tabTotal, difference, missingFromTab, extraInTab } = r;
  const lines = [];
  const src = source ? `${source} ` : "";
  lines.push(`${src}reconciliation: ${counts.statement} statement lines vs ${counts.tab} on the tab, ${counts.matched} matched.`);
  if (missingFromTab.length) {
    lines.push(`On the statement but MISSING from the tab (${missingFromTab.length}) - likely unlogged:`);
    for (const t of missingFromTab) lines.push(`  - ${line(t)}`);
  }
  if (extraInTab.length) {
    lines.push(`On the tab but NOT on the statement (${extraInTab.length}) - review or pending:`);
    for (const t of extraInTab) lines.push(`  - ${line(t)}`);
  }
  lines.push(`Statement total ${money(statementTotal)}, tab total ${money(tabTotal)}, difference ${money(difference)}.`);
  if (!missingFromTab.length && !extraInTab.length && difference === 0) lines.push("Clean: every line ties out.");
  return lines.join("\n");
}
