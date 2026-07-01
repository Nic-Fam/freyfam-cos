import { logTransaction, listTransactions } from "./finance-log.js";
import { createLogger } from "./log.js";

const log = createLogger("chase-csv");

// ===========================================================================
// Generic Chase CSV importer. Chase emails a per-transaction alert for the CREDIT
// card but NOT for most checking activity, so the checking side has to come from
// the "Download account activity" CSV. This parses BOTH Chase CSV layouts, keeps
// only real consumption (drops the card payment, transfers, deposits/income, and
// savings/brokerage moves), and dedupes against what's already logged so a
// re-import — or overlap with the alert feed — never double-counts.
//
//   Credit layout:   Transaction Date,Post Date,Description,Category,Type,Amount,Memo
//   Checking layout: Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
//
// Spend sign convention (matches the rest of the finance log): a purchase is a
// POSITIVE spend; a refund/credit is NEGATIVE so it nets down the month.
// ===========================================================================

const round2 = (x) => Math.round(Number(x) * 100) / 100;

// Minimal CSV line splitter that respects double-quoted fields.
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// "MM/DD/YYYY" -> "YYYY-MM-DD" (Chase's format); pass through an already-ISO date.
function toYmd(s) {
  const m = String(s || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}/.test(String(s)) ? String(s).slice(0, 10) : null;
}

export function detectFormat(headerLine) {
  const h = String(headerLine || "").toLowerCase();
  if (h.includes("transaction date") && h.includes("category")) return "credit";
  if (h.includes("details") && h.includes("posting date")) return "checking";
  return null;
}

const TRANSFER_RE = /online transfer|acct_xfer|to sav|from sav|from chk|to chk|transfer to|transfer from/i;
const CARD_PAYMENT_RE = /payment to chase card|payment thank you|autopay|card ending.*pay/i;
const SAVINGS_RE = /fid bkg|fidelity|moneyline|vanguard|schwab|brokerage|betterment|wealthfront/i;

/**
 * Classify one parsed row -> { include, source, spend, direction, date, merchant, category, reason }.
 * spend: signed (+ = consumption, - = refund/credit). include=false for non-consumption.
 */
export function classifyChaseRow(row, format) {
  if (format === "credit") {
    const date = toYmd(row["Transaction Date"]);
    const amount = Number(row["Amount"]);
    const type = row["Type"] || "";
    const merchant = row["Description"] || null;
    if (!date || !Number.isFinite(amount)) return { include: false, reason: "unparsable" };
    if (/payment/i.test(type)) return { include: false, reason: "card payment", date, merchant };
    const spend = round2(-amount); // sale(-) -> +spend; return/adjustment(+) -> -spend
    return { include: true, source: "credit", spend, direction: spend >= 0 ? "out" : "in", date, merchant, category: row["Category"] || null };
  }
  if (format === "checking") {
    const date = toYmd(row["Posting Date"]);
    const amount = Number(row["Amount"]);
    const merchant = row["Description"] || null;
    const type = row["Type"] || "";
    const hay = `${merchant} ${type}`;
    if (!date || !Number.isFinite(amount)) return { include: false, reason: "unparsable" };
    if (amount > 0) return { include: false, reason: "inflow (deposit/income/refund)", date, merchant };
    if (TRANSFER_RE.test(hay)) return { include: false, reason: "transfer", date, merchant };
    if (CARD_PAYMENT_RE.test(hay)) return { include: false, reason: "card payment", date, merchant };
    if (SAVINGS_RE.test(hay)) return { include: false, reason: "savings/investment", date, merchant };
    const spend = round2(-amount); // debit(-) -> +spend
    return { include: true, source: "checking", spend, direction: "out", date, merchant, category: null };
  }
  return { include: false, reason: "unknown format" };
}

/** Parse a Chase CSV string -> { format, rows: [{header:value}] }. */
export function parseChaseCsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { format: null, rows: [] };
  const format = detectFormat(lines[0]);
  if (!format) return { format: null, rows: [] };
  const headers = splitCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
  return { format, rows };
}

const dedupeKey = (source, date, amount, merchant) =>
  `${source}|${date}|${amount.toFixed(2)}|${String(merchant || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16)}`;

/**
 * Parse + classify + dedupe against existing log rows. Pure (pass `existing`).
 * @returns {{format, source, toLog, skipped, excluded, imported:0, gross, refunds}}
 */
export function prepareImport(text, existing = []) {
  const { format, rows } = parseChaseCsv(text);
  if (!format) return { format: null, error: "Not a recognized Chase CSV (checking or credit).", toLog: [], skipped: [], excluded: [] };
  const seen = new Set(existing.map((t) => dedupeKey(t.source, String(t.date || "").slice(0, 10), Number(t.amount || 0), t.merchant)));
  const toLog = [], skipped = [], excluded = [];
  let gross = 0, refunds = 0;
  for (const row of rows) {
    const c = classifyChaseRow(row, format);
    if (!c.include) { excluded.push({ merchant: c.merchant, reason: c.reason }); continue; }
    const key = dedupeKey(c.source, c.date, c.spend, c.merchant);
    if (seen.has(key)) { skipped.push({ date: c.date, merchant: c.merchant, amount: c.spend }); continue; }
    seen.add(key); // guard against exact dupes within the same file too
    toLog.push({ amount: c.spend, date: c.date, merchant: c.merchant, category: c.category, source: c.source, direction: c.direction, at: `${c.date}T12:00:00Z` });
    if (c.spend >= 0) gross += c.spend; else refunds += -c.spend;
  }
  return { format, source: toLog[0]?.source || format, toLog, skipped, excluded, gross: round2(gross), refunds: round2(refunds) };
}

/**
 * Full import: parse, dedupe against the live log, and log the new rows.
 * @returns a human summary string + counts.
 */
export async function ingestChaseCsv(text, { logFn = logTransaction, existing } = {}) {
  const rows = existing || (await listTransactions({}));
  const prep = prepareImport(text, rows);
  if (!prep.format) return { ok: false, summary: prep.error, imported: 0 };
  for (const t of prep.toLog) await logFn(t);
  log.info("chase csv imported", { format: prep.format, imported: prep.toLog.length, skipped: prep.skipped.length, excluded: prep.excluded.length });
  const net = round2(prep.gross - prep.refunds);
  const summary =
    `Imported ${prep.toLog.length} ${prep.source} transaction(s) from the Chase CSV: ` +
    `$${prep.gross.toFixed(2)} spend` + (prep.refunds ? ` less $${prep.refunds.toFixed(2)} refunds (net $${net.toFixed(2)})` : "") + ". " +
    `Skipped ${prep.skipped.length} already-logged, excluded ${prep.excluded.length} non-spend (payments/transfers/deposits).`;
  return { ok: true, summary, imported: prep.toLog.length, skipped: prep.skipped.length, excluded: prep.excluded.length, format: prep.format };
}

/** Does this attachment look like a Chase CSV we can import? */
export function isChaseCsvAttachment({ name = "", contentType = "", bytes } = {}) {
  const looksCsv = /\.csv$/i.test(name) || /csv/i.test(contentType);
  if (!looksCsv || !bytes) return false;
  const head = (Buffer.isBuffer(bytes) ? bytes.toString("utf8", 0, 200) : String(bytes).slice(0, 200));
  return detectFormat(head.split(/\r?\n/)[0]) != null;
}
