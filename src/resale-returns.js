// TheRealReal RETURNS reconcile -- the Shey + Patrick coordination Nic asked for.
// Resale buying on the card is heavy (TRR dominates the statement) and TRR is the
// only resale site with returns that move the budget. Two halves:
//
//   1. Shey (resale): readTrrReturns() drives the LOCAL logged-in Chrome profile
//      (same surface as the First Look feed) to TRR's orders page and pulls the
//      visible order text + any item anchors. We DON'T hard-code brittle status
//      selectors -- TRR's DOM shifts -- so we return the page text and let the
//      specialist read which orders are marked Return/Refund. Robust by design.
//
//   2. Patrick (finance): reconcileTrrReturns() takes the returned items the
//      specialist identified and matches them against TRR charges/credits in the
//      spend log, so he can subtract expected credits from the month and flag
//      anything charged-but-not-returned. Surfacing only; never moves money.
//
// Browser work stays LOCAL on Lloyd (Playwright + the residential profile), per
// the topology note -- never an Azure specialist.

import { readPage, readListingFeed } from "./channels/browser.js";
import { listTransactions } from "./finance-log.js";

const TRR = {
  base: "https://www.therealreal.com",
  // Account orders/returns surface. Signed in via the persistent Chrome profile,
  // this lists recent orders with their status (incl. returns/refunds). Override
  // with TRR_ORDERS_URL if TRR moves it.
  ordersUrl: process.env.TRR_ORDERS_URL || "https://www.therealreal.com/account/orders",
  orderAnchorPrefix: "/account/orders/",
};

const round2 = (x) => Math.round(Number(x) * 100) / 100;
const isTrr = (m) => /real\s*real/i.test(String(m || ""));

/**
 * Read TRR's orders page from the local signed-in profile. Returns the page text
 * (for the specialist to interpret) plus any order anchors found. `read` and
 * `readAnchors` are injectable for tests. Never throws on a parse miss -- returns
 * what it got with a note.
 */
export async function readTrrReturns({
  read = readPage,
  readAnchors = readListingFeed,
  url = TRR.ordersUrl,
} = {}) {
  let text = "";
  let orders = [];
  let note = null;
  try {
    const page = await read(url, { maxChars: 8000, timeoutMs: 30000 });
    text = typeof page === "string" ? page : page?.text || "";
  } catch (e) {
    note = `Could not read TRR orders page: ${e.message}. The Chrome profile may need a fresh sign-in.`;
  }
  try {
    orders = await readAnchors(url, { anchorPrefix: TRR.orderAnchorPrefix, max: 40, timeoutMs: 30000 });
  } catch {
    /* anchors are best-effort; the text is the primary signal */
  }
  return { url, text, orders, note };
}

/**
 * Reconcile a list of returned items (as the specialist identified them) against
 * the TRR charges/credits in the spend log. `returns` is an array of
 * {item?, brand?, amount?, order?} the specialist pulled off the orders page.
 * Pulls TRR transactions over the window and splits charges (+) from credits (-).
 * `list` is injectable for tests.
 *
 * Returns { window, charges, credits, chargeTotal, creditReceived, returnsClaimed,
 *           expectedCredit, outstanding, text }.
 */
export async function reconcileTrrReturns({ returns = [], sinceDays = 120, list = listTransactions } = {}) {
  const txns = (await list({ sinceDays, merchant: "realreal" })) || [];
  // Some logs store credits as negative amounts, some flag direction. Treat a
  // negative amount OR direction:"in"/"credit" as a credit (refund) back.
  const isCredit = (t) => Number(t.amount) < 0 || /in|credit|refund|return/i.test(String(t.direction || ""));
  const charges = txns.filter((t) => !isCredit(t));
  const credits = txns.filter((t) => isCredit(t));
  const chargeTotal = round2(charges.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0));
  const creditReceived = round2(credits.reduce((s, t) => s + Math.abs(Number(t.amount) || 0), 0));

  const returnsClaimed = (returns || []).filter((r) => r && (r.item || r.brand || r.amount));
  const expectedCredit = round2(returnsClaimed.reduce((s, r) => s + (Number(r.amount) || 0), 0));
  // What the family expects back but the card has not yet credited.
  const outstanding = round2(Math.max(0, expectedCredit - creditReceived));

  return {
    window: sinceDays,
    charges: charges.length,
    credits: credits.length,
    chargeTotal,
    creditReceived,
    returnsClaimed: returnsClaimed.length,
    expectedCredit,
    outstanding,
    items: returnsClaimed,
    text: formatTrrReconcile({ sinceDays, chargeTotal, creditReceived, returnsClaimed, expectedCredit, outstanding }),
  };
}

/** Human one-block summary for Patrick's reply. Plain punctuation, no em dashes. */
export function formatTrrReconcile({ sinceDays, chargeTotal, creditReceived, returnsClaimed = [], expectedCredit, outstanding }) {
  const lines = [
    `TheRealReal, last ${sinceDays} days:`,
    `  Charges on the card: $${(chargeTotal || 0).toFixed(2)}`,
    `  Credits already received: $${(creditReceived || 0).toFixed(2)}`,
  ];
  if (returnsClaimed.length) {
    lines.push(`  Returns in progress (${returnsClaimed.length}): expected credit $${(expectedCredit || 0).toFixed(2)}`);
    lines.push(`  Still outstanding (expected back, not yet credited): $${(outstanding || 0).toFixed(2)}`);
  } else {
    lines.push(`  No returns identified from the orders page yet.`);
  }
  return lines.join("\n");
}

export const _TRR = TRR; // test/config visibility
