// Weekly finance report (Patrick), delivered Sunday night to the owner. Reports
// checking and credit spend SEPARATELY, each with month-over-month and
// year-over-year vs the baseline store. The first Sunday of the month also runs
// a prior-month retrospective AND closes that month into the baselines (from the
// log) so comparisons get richer over time. Composition is deterministic (no
// model) — the only model spend is the daily ingest's Haiku batch.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { FINANCE_REPORT } from "./config.js";
import { notifyOwner } from "./channels/notify.js";
import { sendMail } from "./channels/graph.js";
import { localParts } from "./digest.js";
import { listTransactions, summarizeSpend } from "./finance-log.js";
import { listReceipts, reconcileReceipts, formatReconcile } from "./receipts.js";
import { monthOverMonth, yearOverYear, setMonthly, formatDelta } from "./finance-baselines.js";

const round2 = (x) => Math.round(Number(x) * 100) / 100;
const SOURCES = ["checking", "credit"];
const label = (s) => (s === "checking" ? "Checking" : "Credit card");

function weekdayOf(localDate) {
  return new Date(`${localDate}T12:00:00Z`).getUTCDay(); // 0 = Sunday, in the local day
}
function ymOf(localDate) {
  return localDate.slice(0, 7);
}
function shiftYm(ym, deltaMonths) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isFirstSunday(localDate) {
  return weekdayOf(localDate) === 0 && Number(localDate.slice(8, 10)) <= 7;
}

/** Should the weekly report run now? Sunday, in the evening window, once per day. */
export function shouldRunWeeklyReport(now, lastRunDate, cfg = FINANCE_REPORT) {
  const { weekday = 0, hour = 20, tz = "America/Los_Angeles", windowHours = 3 } = cfg;
  const { date, hour: h } = localParts(now, tz);
  const onDay = weekdayOf(date) === weekday;
  const inWindow = h >= hour && h < hour + windowHours;
  return { run: onDay && inWindow && lastRunDate !== date, date };
}

// Persisted once-per-week guard (survives restarts), same pattern as the digest.
const statePath = () => process.env.FINANCE_REPORT_STATE_PATH || "./data/finance-report-state.json";
export async function getLastReportDate() {
  try { return JSON.parse(await readFile(statePath(), "utf8")).lastRunDate || null; } catch { return null; }
}
export async function setLastReportDate(date) {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify({ lastRunDate: date }, null, 2));
}

async function monthTotalFromLog(source, ym) {
  const txns = await listTransactions({ source });
  return round2(txns.filter((t) => String(t.date || "").startsWith(ym)).reduce((s, t) => s + t.amount, 0));
}

/**
 * Build the report text for a given moment. Deterministic. Returns
 * { subject, text, smsHeadsUp, monthly }. `monthly` lists the prior-month closes
 * to persist (only on the first Sunday).
 */
export async function composeWeeklyReport({ now = new Date(), tz = FINANCE_REPORT.tz } = {}) {
  const { date } = localParts(now, tz);
  const ym = ymOf(date);
  const firstSunday = isFirstSunday(date);
  const lines = [];
  const monthly = []; // {source, ym, total} to persist after delivery

  lines.push(`Week ending ${date}.`);

  for (const source of SOURCES) {
    const week = await summarizeSpend({ sinceDays: 7, source, now });
    const mtd = await monthTotalFromLog(source, ym);
    const mom = await monthOverMonth({ source, ym, currentTotal: mtd });
    const yoy = await yearOverYear({ source, ym, currentTotal: mtd });
    lines.push(
      `\n${label(source)}: $${week.total.toFixed(2)} this week, $${mtd.toFixed(2)} month-to-date.` +
        `\n  ${formatDelta("MoM", mom)}` +
        `\n  ${formatDelta("YoY", yoy)}`
    );
    if (source === "credit" && (week.duplicates.length || week.notable.length)) {
      if (week.duplicates.length) lines.push(`  Possible duplicates: ${week.duplicates.map((d) => `${d.merchant} $${d.amount}`).join("; ")}`);
      if (week.notable.length) lines.push(`  Notable jumps: ${week.notable.map((n) => `${n.merchant} $${n.amount}`).join("; ")}`);
    }
  }

  // Receipt reconciliation (double entry = the reconciliation): match the week's
  // auto-forwarded receipts to card charges. Confirms + itemizes matched purchases,
  // surfaces receipts with no charge yet, and flags amount mismatches to check.
  try {
    const weekReceipts = await listReceipts({ sinceDays: 7 }, now);
    if (weekReceipts.length) {
      const rline = formatReconcile(reconcileReceipts(weekReceipts, await listTransactions({ sinceDays: 10 })));
      if (rline) lines.push(`\n${rline}`);
    }
  } catch { /* non-fatal: reconciliation is additive */ }

  if (firstSunday) {
    const prior = shiftYm(ym, -1);
    lines.push(`\nPrior-month retrospective (${prior}):`);
    for (const source of SOURCES) {
      const total = await monthTotalFromLog(source, prior);
      const mom = await monthOverMonth({ source, ym: prior, currentTotal: total });
      const yoy = await yearOverYear({ source, ym: prior, currentTotal: total });
      lines.push(`  ${label(source)}: $${total.toFixed(2)}. ${formatDelta("MoM", mom)}. ${formatDelta("YoY", yoy)}.`);
      monthly.push({ source, ym: prior, total }); // close the month into baselines
    }
  }

  const text = lines.join("\n");
  const subject = `${firstSunday ? "Monthly + weekly" : "Weekly"} finance report: week ending ${date}`;
  const smsHeadsUp = `Finance report (${date}): see email for the full ${firstSunday ? "monthly + weekly" : "weekly"} breakdown.`;
  return { subject, text, smsHeadsUp, monthly, firstSunday };
}

/**
 * Compose + deliver to the owner (sensitive, so owner-only): a short SMS heads-up
 * plus the full report by email. On the first Sunday, persist the prior month's
 * totals into the baseline store so future MoM/YoY get richer. Channels injectable.
 */
export async function runWeeklyFinanceReport({ notify = notifyOwner, mail = sendMail, now = new Date(), cfg = FINANCE_REPORT } = {}) {
  const report = await composeWeeklyReport({ now, tz: cfg.tz });

  // Close prior month(s) into baselines (idempotent upsert).
  for (const m of report.monthly) {
    try { await setMonthly(m); } catch { /* non-fatal */ }
  }

  const results = await Promise.allSettled([
    notify(report.smsHeadsUp),
    cfg.emailTo.length
      ? mail({ to: cfg.emailTo, subject: report.subject, body: report.text })
      : Promise.resolve("no email recipients"),
  ]);
  return { report, results };
}
