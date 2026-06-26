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
export async function logTransaction({ amount, date, merchant, card, category, note } = {}) {
  if (amount == null || Number.isNaN(Number(amount))) throw new Error("amount is required");
  const item = {
    id: randomUUID().slice(0, 8),
    amount: round2(amount),
    date: date ? String(date).trim() : new Date().toISOString().slice(0, 10),
    merchant: merchant ? String(merchant).trim() : null,
    card: card ? String(card).trim() : null,
    category: category ? String(category).trim() : null,
    note: note ? String(note).trim() : null,
    at: new Date().toISOString(),
  };
  await col().add(item);
  return item;
}

/** Newest-first list, optionally filtered by recency window, card, or merchant. */
export async function listTransactions({ sinceDays, card, merchant } = {}) {
  let items = await col().list();
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
export async function summarizeSpend({ sinceDays = 7, now = new Date() } = {}) {
  const txns = await listTransactions({ sinceDays });
  const analysis = analyzeTransactions(txns);
  const recurring = detectRecurring(txns, { now });
  return { window: sinceDays, ...analysis, recurring };
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
