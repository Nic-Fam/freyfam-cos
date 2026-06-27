import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const LOG = join(os.tmpdir(), "cos-finrep-log-test.json");
const BASE = join(os.tmpdir(), "cos-finrep-base-test.json");
process.env.FINANCE_LOG_PATH = LOG;
process.env.FINANCE_BASELINES_PATH = BASE;
const { isFirstSunday, shouldRunWeeklyReport, composeWeeklyReport, runWeeklyFinanceReport } =
  await import("../src/finance-report.js");
const { logTransaction } = await import("../src/finance-log.js");
const { setMonthly } = await import("../src/finance-baselines.js");

beforeEach(async () => { await rm(LOG, { force: true }); await rm(BASE, { force: true }); });
after(async () => { await rm(LOG, { force: true }); await rm(BASE, { force: true }); });

test("isFirstSunday", () => {
  assert.equal(isFirstSunday("2026-06-07"), true);  // first Sunday of June 2026
  assert.equal(isFirstSunday("2026-06-14"), false); // a later Sunday
  assert.equal(isFirstSunday("2026-06-08"), false); // a Monday
});

test("shouldRunWeeklyReport fires only on the configured weekday + window, once/day", () => {
  const cfg = { weekday: 0, hour: 20, tz: "America/Los_Angeles", windowHours: 3 };
  const sundayEve = new Date("2026-06-14T20:30:00-07:00");
  assert.equal(shouldRunWeeklyReport(sundayEve, null, cfg).run, true);
  assert.equal(shouldRunWeeklyReport(sundayEve, "2026-06-14", cfg).run, false); // already ran
  const mondayEve = new Date("2026-06-15T20:30:00-07:00");
  assert.equal(shouldRunWeeklyReport(mondayEve, null, cfg).run, false); // not Sunday
  const sundayMorning = new Date("2026-06-14T09:00:00-07:00");
  assert.equal(shouldRunWeeklyReport(sundayMorning, null, cfg).run, false); // outside window
});

test("composeWeeklyReport breaks out checking vs credit with MoM/YoY", async () => {
  // current month (June 2026) logged transactions, per source
  await logTransaction({ amount: 100, merchant: "Ralphs", source: "checking", date: "2026-06-10" });
  await logTransaction({ amount: 50, merchant: "Uber Eats", source: "credit", date: "2026-06-11" });
  // prior month + prior year baselines for comparison
  await setMonthly({ source: "checking", ym: "2026-05", total: 80 });
  await setMonthly({ source: "credit", ym: "2026-05", total: 40 });
  await setMonthly({ source: "checking", ym: "2025-06", total: 90 });

  const { text } = await composeWeeklyReport({ now: new Date("2026-06-14T20:30:00-07:00") });
  assert.match(text, /Checking: \$100\.00 this week/);
  assert.match(text, /Credit card: \$50\.00 this week/);
  assert.match(text, /MoM: \+25%/);   // checking 100 vs 80
  assert.match(text, /YoY:/);          // checking has a prior-year month
});

test("first Sunday adds a prior-month retrospective and persists the close", async () => {
  await logTransaction({ amount: 200, merchant: "rent", source: "checking", date: "2026-05-01" });
  const captured = [];
  const fakeMail = async (m) => { captured.push(m); return "ok"; };
  const fakeNotify = async () => "ok";

  const { report } = await runWeeklyFinanceReport({
    notify: fakeNotify, mail: fakeMail, now: new Date("2026-06-07T20:30:00-07:00"),
    cfg: { weekday: 0, hour: 20, tz: "America/Los_Angeles", windowHours: 3, emailTo: ["nic@freyfam.com"] },
  });
  assert.equal(report.firstSunday, true);
  assert.match(report.text, /Prior-month retrospective \(2026-05\)/);
  assert.ok(report.monthly.some((m) => m.ym === "2026-05" && m.source === "checking"));
  assert.equal(captured.length, 1);                 // emailed
  assert.match(captured[0].subject, /Monthly \+ weekly/);
});
