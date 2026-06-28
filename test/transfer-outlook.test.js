import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const OBL = join(os.tmpdir(), "cos-to-obl.json");
const LOG = join(os.tmpdir(), "cos-to-log.json");
const ANCHOR = join(os.tmpdir(), "cos-to-anchor.json");
const STMT = join(os.tmpdir(), "cos-to-stmt.json");
process.env.OBLIGATIONS_PATH = OBL;
process.env.FINANCE_LOG_PATH = LOG;
process.env.CHECKING_ANCHOR_PATH = ANCHOR;
process.env.CREDIT_STATEMENT_PATH = STMT;
process.env.FAMILY_TZ = "America/Los_Angeles";

const { addObligation } = await import("../src/obligations.js");
const { logTransaction } = await import("../src/finance-log.js");
const { setCheckingAnchor } = await import("../src/checking-balance.js");
const { setStatement } = await import("../src/credit-statement.js");
const { transferOutlook, cycleThrough, cycleMonth, shouldRunTransferOutlook } = await import("../src/transfer-outlook.js");

const clean = async () => { for (const f of [OBL, LOG, ANCHOR, STMT]) await rm(f, { force: true }); };
beforeEach(clean);
after(clean);

test("cycleThrough = last day of the month containing the next 1st", () => {
  assert.equal(cycleThrough(new Date("2026-06-28T12:00:00-07:00")), "2026-07-31");
  assert.equal(cycleThrough(new Date("2026-07-01T12:00:00-07:00")), "2026-07-31"); // on the 1st = this cycle
  assert.equal(cycleThrough(new Date("2026-07-03T12:00:00-07:00")), "2026-08-31"); // after the 1st = next
  assert.equal(cycleThrough(new Date("2026-12-20T12:00:00-08:00")), "2027-01-31"); // year rollover
});

test("shouldRunTransferOutlook fires once in the window before the 1st", () => {
  const near = new Date("2026-06-28T12:00:00-07:00"); // 3 days before Jul 1
  assert.deepEqual(shouldRunTransferOutlook(near, null), { run: true, cycle: "2026-07" });
  assert.equal(shouldRunTransferOutlook(near, "2026-07").run, false, "already done this cycle");
  const far = new Date("2026-06-20T12:00:00-07:00");
  assert.equal(shouldRunTransferOutlook(far, null).run, false, "not in the window yet");
  assert.equal(cycleMonth(near), "2026-07");
});

async function seedHousehold() {
  await addObligation({ name: "Rent", amount: 5951.40, cadence: "monthly", dueDay: 1 });
  await addObligation({ name: "Car payment", amount: 1400, cadence: "monthly", dueDay: 1 });
  await addObligation({ name: "BrightHorizons", amount: 509, cadence: "weekly", dueWeekday: 5 });
  await addObligation({ name: "Credit card payment", cadence: "monthly", dueDay: 6, variable: true });
  await addObligation({ name: "Nic paycheck", amount: 4048.66, cadence: "biweekly", anchorDate: "2026-06-12", direction: "in" });
  await setCheckingAnchor({ amount: 5401.43, asOf: "2026-06-01T00:00:00Z" });
}

test("with no statement captured, the card payment falls back to summed charges (rough floor)", async () => {
  await seedHousehold();
  await logTransaction({ amount: 10000, source: "credit", direction: "out", date: "2026-06-10", at: "2026-06-10T00:00:00Z" });
  await logTransaction({ amount: 5963.29, source: "credit", direction: "out", date: "2026-06-18", at: "2026-06-18T00:00:00Z" });

  const o = await transferOutlook({ now: new Date("2026-06-28T12:00:00-07:00") });
  assert.equal(o.ccEstimate, 15963.29);
  assert.equal(o.cc.basis, "charges");
  assert.equal(o.balance.balance, 5401.43);
  assert.equal(o.requiredTransfer, 19932);
  assert.match(o.text, /transfer in about \$19,932/);
  assert.match(o.text, /~\$15,963\.29 \(2 logged charges/);
});

test("a captured STATEMENT balance is preferred over summed charges", async () => {
  await seedHousehold();
  await logTransaction({ amount: 459.54, source: "credit", direction: "out", date: "2026-06-25", at: "2026-06-25T00:00:00Z" }); // only a few recent charges logged
  await setStatement({ card: "1234", statementBalance: 15963.29, dueDate: "2026-07-06" });

  const o = await transferOutlook({ now: new Date("2026-06-28T12:00:00-07:00") });
  assert.equal(o.cc.basis, "statement");
  assert.equal(o.ccEstimate, 15963.29); // statement balance, NOT the $459.54 of logged charges
  assert.equal(o.requiredTransfer, 19932);
  assert.match(o.text, /statement balance/);
});

test("transferOutlook reports needsBalance when there is no anchor", async () => {
  await addObligation({ name: "Rent", amount: 5951.40, cadence: "monthly", dueDay: 1 });
  const o = await transferOutlook({ now: new Date("2026-06-28T12:00:00-07:00") });
  assert.equal(o.needsBalance, true);
  assert.match(o.text, /no current checking balance/);
});
