// Checking-balance ledger for the finance specialist (Patrick). The transaction
// log records each checking flow with a sign (direction) and, when the bank alert
// states one, the available balance AFTER that transaction. This module turns that
// stream into a current balance WITHOUT asking the family every time:
//
//   balance = most recent authoritative anchor + every signed checking flow since.
//
// An "anchor" is either a bank-stated balance snapshot (most trustworthy) or a
// balance the family set by hand (set_checking_balance). We take whichever is more
// recent, then apply the checking transactions logged after it (deposits add,
// debits subtract). Monthly statement reconciliation (reconcile.js) is the backstop
// that re-anchors if alerts were missed and the running balance drifted.
//
// Surfacing only; never moves money.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { listTransactions } from "./finance-log.js";

const round2 = (x) => Math.round(Number(x) * 100) / 100;
const anchorPath = () => process.env.CHECKING_ANCHOR_PATH || "./data/checking-anchor.json";

/** Manually set/override the known checking balance (a hard anchor). */
export async function setCheckingAnchor({ amount, asOf } = {}) {
  if (amount == null || Number.isNaN(Number(amount))) throw new Error("amount is required");
  const item = { amount: round2(amount), asOf: asOf || new Date().toISOString() };
  await mkdir(dirname(anchorPath()), { recursive: true });
  await writeFile(anchorPath(), JSON.stringify(item, null, 2));
  return item;
}

export async function getCheckingAnchor() {
  try {
    const a = JSON.parse(await readFile(anchorPath(), "utf8"));
    return a && a.amount != null ? a : null;
  } catch {
    return null;
  }
}

/**
 * Current checking balance: the most recent anchor (bank-stated snapshot or a
 * hand-set balance), advanced by every signed checking flow logged after it.
 * @returns {Promise<{balance:number|null, basis:"bank-alert"|"manual"|"none",
 *   asOf:string|null, anchorBalance:number|null, flowsApplied:number}>}
 */
export async function getCheckingBalance({ now = new Date() } = {}) {
  const checking = await listTransactions({ source: "checking" }); // newest-first
  const snap = checking.find((t) => typeof t.balance === "number"); // most recent bank-stated balance
  const manual = await getCheckingAnchor();

  let anchor = null;
  if (snap) anchor = { amount: snap.balance, at: snap.at, basis: "bank-alert" };
  if (manual && (!anchor || Date.parse(manual.asOf) > Date.parse(anchor.at))) {
    anchor = { amount: round2(manual.amount), at: manual.asOf, basis: "manual" };
  }
  if (!anchor) return { balance: null, basis: "none", asOf: null, anchorBalance: null, flowsApplied: 0 };

  // Apply checking flows strictly AFTER the anchor moment (the snapshot balance
  // already includes its own transaction; the manual anchor is "as of" its time).
  const after = checking.filter((t) => Date.parse(t.at) > Date.parse(anchor.at));
  let balance = anchor.amount;
  for (const t of after) balance = round2(balance + (t.direction === "in" ? t.amount : -t.amount));
  return { balance, basis: anchor.basis, asOf: anchor.at, anchorBalance: round2(anchor.amount), flowsApplied: after.length };
}
