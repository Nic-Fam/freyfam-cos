// Running TRANSACTION log for the finance specialist (Patrick). Transaction
// alert emails forwarded to the cos mailbox are routed to finance; Patrick
// records each one here with `log_transaction`, and the morning digest pulls a
// rollup via `summarizeSpend`. Surfacing only — it never moves money (hard
// constraint #3); it just remembers what posted so spend can be tracked over
// time. The rollup reuses the pure analyzers in finance.js (category totals,
// duplicate detection, price-jump + recurring radar) over the logged set.
//
// Storage is pluggable (src/stores/collection.js): local JSON by default, or the
// finance specialist's own managed-identity Azure Table when COS_TABLE_* is set.
// Same add/list API either way, so this works in-process on Lloyd or on a remote
// Flex Function without a caller change.

import { randomUUID } from "node:crypto";
import { createCollection } from "./stores/collection.js";
import { analyzeTransactions, detectRecurring } from "./finance.js";

const col = () =>
  createCollection({
    file: process.env.FINANCE_LOG_PATH || "./data/finance-log.json",
    partition: "financelog",
  });

const round2 = (x) => Math.round(Number(x) * 100) / 100;

/**
 * Record one transaction from a forwarded alert.
 * @param {{amount:number, date?:string, merchant?:string, card?:string,
 *          category?:string, note?:string}} input
 */
export async function logTransaction({ amount, date, merchant, card, category, note, source } = {}) {
  if (amount == null || Number.isNaN(Number(amount))) throw new Error("amount is required");
  const item = {
    id: randomUUID().slice(0, 8),
    amount: round2(amount),
    date: date ? String(date).trim() : new Date().toISOString().slice(0, 10),
    merchant: merchant ? String(merchant).trim() : null,
    card: card ? String(card).trim() : null,
    // source separates credit-card spend from checking-account spend so the
    // weekly report can break them out. Defaults to "credit" (card alerts are
    // the common case); checking ingestion passes "checking".
    source: source === "checking" ? "checking" : "credit",
    category: category ? String(category).trim() : null,
    note: note ? String(note).trim() : null,
    at: new Date().toISOString(),
  };
  await col().add(item);
  return item;
}

/** Newest-first list, optionally filtered by recency window, source, card, or merchant. */
export async function listTransactions({ sinceDays, source, card, merchant } = {}) {
  let items = await col().list();
  if (source) items = items.filter((it) => (it.source || "credit") === source);
  if (card) {
    const c = String(card).trim().toLowerCase();
    items = items.filter((it) => String(it.card || "").toLowerCase().includes(c));
  }
  if (merchant) {
    const m = String(merchant).trim().toLowerCase();
    items = items.filter((it) => String(it.merchant || "").toLowerCase().includes(m));
  }
  if (sinceDays != null) {
    const cutoff = Date.now() - Number(sinceDays) * 24 * 60 * 60 * 1000;
    items = items.filter((it) => Date.parse(it.at) >= cutoff);
  }
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * Rollup for the digest / Patrick's reply over a recency window. Runs the pure
 * finance.js analyzers over the logged transactions: total, totals by category,
 * duplicate charges, notable price jumps, and the recurring-charge radar.
 * @returns {{window:number, count:number, total:number, totalsByCategory:object,
 *           duplicates:Array, notable:Array, recurring:Array}}
 */
export async function summarizeSpend({ sinceDays = 7, source, now = new Date() } = {}) {
  const txns = await listTransactions({ sinceDays, source });
  const analysis = analyzeTransactions(txns);
  const recurring = detectRecurring(txns, { now });
  return { window: sinceDays, source: source || "all", ...analysis, recurring };
}

// Local "YYYY-MM" for the family timezone (statement month anchor).
function localYm(now = new Date(), tz = process.env.FAMILY_TZ || "America/Los_Angeles") {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}`;
}

/**
 * The RUNNING TAB: month-to-date totals + counts, split checking vs credit, from
 * the logged transactions. This is Patrick's live tally that the monthly statement
 * is later reconciled against. Anchored on the transaction DATE (not ingest time)
 * so it matches a statement period. Surfacing only.
 * @returns {{month, checking:{count,total}, credit:{count,total}, combined, transactions}}
 */
export async function runningTab({ ym, now = new Date() } = {}) {
  const month = ym || localYm(now);
  const all = await listTransactions({});
  const items = all.filter((t) => String(t.date || t.at || "").slice(0, 7) === month);
  const acc = { checking: { count: 0, total: 0 }, credit: { count: 0, total: 0 } };
  for (const t of items) {
    const s = t.source === "checking" ? "checking" : "credit";
    acc[s].count += 1;
    acc[s].total = round2(acc[s].total + Number(t.amount || 0));
  }
  return { month, checking: acc.checking, credit: acc.credit, combined: round2(acc.checking.total + acc.credit.total), transactions: items };
}

/** Human one-line running tab. Pure. */
export function formatRunningTab(tab) {
  if (!tab) return "No running tab.";
  const m = (n) => "$" + round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Running tab ${tab.month}: checking ${m(tab.checking.total)} (${tab.checking.count}), credit ${m(tab.credit.total)} (${tab.credit.count}); combined ${m(tab.combined)}.`;
}

/** Human one-block summary for Patrick's reply / the digest. Pure. */
export function formatSpend(summary) {
  const { window = 7, count = 0, total = 0, totalsByCategory = {}, duplicates = [], notable = [] } = summary || {};
  if (!count) return `No transactions logged in the last ${window} days.`;
  const cats = Object.entries(totalsByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([c, amt]) => `${c} $${amt.toFixed(2)}`);
  let out = `Last ${window}d: ${count} charges, $${total.toFixed(2)} total.`;
  if (cats.length) out += ` Top: ${cats.join(", ")}.`;
  if (duplicates.length) out += ` Possible duplicates: ${duplicates.map((d) => `${d.merchant} $${d.amount}`).join("; ")}.`;
  if (notable.length) out += ` Notable jumps: ${notable.map((n) => `${n.merchant} $${n.amount} (vs ~$${n.baseline})`).join("; ")}.`;
  return out;
}
