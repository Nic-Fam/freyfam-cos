// "Going forward" transfer outlook for the finance specialist (Patrick): compute
// the once-a-month joint-checking transfer from the transactions Patrick already
// ingests daily, instead of asking the family for the inputs each month.
//
//   - current balance      <- checking-balance ledger (bank-stated anchor + flows)
//   - credit card payment  <- the captured STATEMENT balance (what's actually due),
//                             falling back to this cycle's logged charges if no
//                             fresh statement has been captured yet
//   - recurring bills/pay   <- the recorded obligations (rent, car, BrightHorizons,
//                             biweekly paycheck)
//
// Horizon = the month the next 1st falls in, so one transfer covers that cycle.
// Surfacing only; a human makes the transfer.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { listObligations, planCheckingTransfer, todayYmd } from "./obligations.js";
import { getCheckingBalance } from "./checking-balance.js";
import { runningTab } from "./finance-log.js";
import { currentStatementPayment } from "./credit-statement.js";

const round2 = (x) => Math.round(Number(x) * 100) / 100;
const money = (n) => "$" + round2(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Last day of the month containing the NEXT 1st-of-month (>= today): the cycle a
// transfer made now (before the 1st) should cover. Jun 28 -> 2026-07-31.
export function cycleThrough(now = new Date()) {
  const [y, m, d] = todayYmd(now).split("-").map(Number);
  // month index (1-12) of the cycle: this month if today IS the 1st, else next month
  let cy = y, cm = d === 1 ? m : m + 1;
  if (cm > 12) { cm = 1; cy += 1; }
  const lastDay = new Date(Date.UTC(cy, cm, 0)).getUTCDate(); // day 0 of next month = last day
  return `${cy}-${String(cm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Compute the monthly transfer from the live transaction data. `complete`-free and
 * deterministic given the stores. Returns the plan plus the derived inputs and a
 * human summary; if there is no balance to anchor on, returns needsBalance.
 */
export async function transferOutlook({ now = new Date(), throughDate } = {}) {
  const bal = await getCheckingBalance({ now });
  const tab = await runningTab({ now });
  // Prefer the captured STATEMENT balance (what's actually due); fall back to summing
  // this cycle's logged charges (a rough floor) until a statement is captured.
  const stmt = await currentStatementPayment({ now });
  const ccEstimate = stmt ? stmt.total : round2(tab.credit.total);
  const cc = {
    amount: ccEstimate,
    basis: stmt ? "statement" : "charges",
    detail: stmt
      ? `statement balance${stmt.cards > 1 ? ` across ${stmt.cards} cards` : ""}`
      : `${tab.credit.count} logged charge${tab.credit.count === 1 ? "" : "s"} this cycle (rough floor; no statement captured yet)`,
  };
  const through = throughDate || cycleThrough(now);

  if (bal.balance == null) {
    return {
      needsBalance: true, ccEstimate, cc, ccChargeCount: tab.credit.count, through,
      text: "I can't compute the transfer yet: I have no current checking balance to anchor on (no balance in recent bank alerts, and none set). Tell me the balance with set_checking_balance, or it will anchor itself from the next deposit/debit alert that carries one.",
    };
  }

  const plan = await planCheckingTransfer({ currentBalance: bal.balance, creditCardPayment: ccEstimate, throughDate: through, now });
  return { ...plan, balance: bal, ccEstimate, cc, ccChargeCount: tab.credit.count, text: formatOutlook(plan, bal, cc) };
}

// "YYYY-MM" of the cycle the next transfer covers (the month of the next 1st).
export function cycleMonth(now = new Date()) {
  return cycleThrough(now).slice(0, 7);
}

function daysUntilNextFirst(now = new Date()) {
  const [y, m, d] = todayYmd(now).split("-").map(Number);
  if (d === 1) return 0;
  const nextFirst = m === 12 ? Date.UTC(y + 1, 0, 1) : Date.UTC(y, m, 1); // first of next month
  const today = Date.UTC(y, m - 1, d);
  return Math.round((nextFirst - today) / 86400000);
}

/**
 * Should the monthly transfer outlook fire now? True in the `daysBefore`-day window
 * before the 1st, once per cycle. Pure; the caller persists `lastCycle`.
 */
export function shouldRunTransferOutlook(now, lastCycle, { daysBefore = 3 } = {}) {
  const cycle = cycleMonth(now);
  const within = daysUntilNextFirst(now) <= daysBefore;
  return { run: within && lastCycle !== cycle, cycle };
}

const statePath = () => process.env.TRANSFER_OUTLOOK_STATE_PATH || "./data/transfer-outlook-state.json";
export async function getLastOutlookCycle() {
  try { return JSON.parse(await readFile(statePath(), "utf8")).lastCycle || null; } catch { return null; }
}
export async function setLastOutlookCycle(cycle) {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify({ lastCycle: cycle }, null, 2));
}

export function formatOutlook(plan, bal, cc) {
  const asOf = bal.asOf ? bal.asOf.slice(0, 10) : "unknown";
  const src = bal.basis === "bank-alert" ? "from a bank alert" : bal.basis === "manual" ? "set by hand" : "unknown source";
  const ccLine = cc.basis === "statement"
    ? `credit card payment ${money(cc.amount)} (${cc.detail})`
    : `credit card payment ~${money(cc.amount)} (${cc.detail})`;
  const lines = [
    `Inputs (from your transaction feed): checking balance ${money(bal.balance)} (${src}, as of ${asOf}${bal.flowsApplied ? `, +${bal.flowsApplied} flows since` : ""}); ${ccLine}.`,
    "",
    plan.text,
  ];
  return lines.join("\n");
}
