import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-finance-baselines-test.json");
process.env.FINANCE_BASELINES_PATH = TMP;
const { setMonthly, getMonthly, listMonthly, monthOverMonth, yearOverYear, formatDelta } =
  await import("../src/finance-baselines.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("setMonthly upserts (no duplicate rows per source+ym)", async () => {
  await setMonthly({ source: "checking", ym: "2026-04", total: 8000 });
  await setMonthly({ source: "checking", ym: "2026-04", total: 8328.13 }); // correction
  const all = await listMonthly({ source: "checking" });
  assert.equal(all.length, 1);
  assert.equal(all[0].total, 8328.13);
});

test("separate sources are tracked independently", async () => {
  await setMonthly({ source: "checking", ym: "2026-05", total: 11294 });
  await setMonthly({ source: "credit", ym: "2026-05", total: 13880 });
  assert.equal((await getMonthly("checking", "2026-05")).total, 11294);
  assert.equal((await getMonthly("credit", "2026-05")).total, 13880);
  assert.equal((await listMonthly({ source: "credit" })).length, 1);
});

test("month-over-month computes delta vs the prior month", async () => {
  await setMonthly({ source: "checking", ym: "2026-04", total: 8328.13 });
  const mom = await monthOverMonth({ source: "checking", ym: "2026-05", currentTotal: 11294.28 });
  assert.equal(mom.priorYm, "2026-04");
  assert.equal(mom.prior, 8328.13);
  assert.equal(mom.deltaPct, 35.6); // (11294.28-8328.13)/8328.13
  assert.match(formatDelta("MoM", mom), /\+35\.6%/);
});

test("year-over-year compares the same month a year earlier, and degrades cleanly", async () => {
  await setMonthly({ source: "checking", ym: "2025-06", total: 5000 });
  const yoy = await yearOverYear({ source: "checking", ym: "2026-06", currentTotal: 6000 });
  assert.equal(yoy.priorYm, "2025-06");
  assert.equal(yoy.deltaAbs, 1000);

  const missing = await yearOverYear({ source: "credit", ym: "2026-06", currentTotal: 100 });
  assert.equal(missing.prior, null);
  assert.match(formatDelta("YoY", missing), /no prior data/);
});
