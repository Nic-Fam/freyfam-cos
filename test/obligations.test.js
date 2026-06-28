import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-obligations-test.json");
process.env.OBLIGATIONS_PATH = TMP;
process.env.FAMILY_TZ = "America/Los_Angeles";
const {
  addObligation, listObligations, removeObligation,
  projectOutflows, planTransfer, planCheckingTransfer, formatTransferPlan,
} = await import("../src/obligations.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("planTransfer protects the LOWEST point, not just the ending balance", () => {
  // start $2000; a big bill drops it to -$500 mid-window, then a paycheck recovers it.
  const plan = planTransfer({
    currentBalance: 2000,
    buffer: 1000,
    outflows: [{ name: "Rent", amount: 2500, date: "2026-06-30" }],
    inflows: [{ name: "Paycheck", amount: 3000, date: "2026-07-01" }],
  });
  // ending balance is healthy ($2500) but the dip hit -$500, so we must top up to +$1000:
  assert.equal(plan.minBalance, -500);
  assert.equal(plan.minDate, "2026-06-30");
  assert.equal(plan.requiredTransfer, 1500); // 1000 - (-500)
  assert.equal(plan.endingBalance, 2500);
});

test("no transfer needed when the buffer always holds", () => {
  const plan = planTransfer({
    currentBalance: 5000, buffer: 1000,
    outflows: [{ name: "BrightHorizons", amount: 340, date: "2026-07-02" }],
  });
  assert.equal(plan.requiredTransfer, 0);
});

test("outflows apply before inflows on the same day (conservative)", () => {
  const plan = planTransfer({
    currentBalance: 1000, buffer: 1000,
    outflows: [{ name: "Bill", amount: 800, date: "2026-07-05" }],
    inflows: [{ name: "Deposit", amount: 800, date: "2026-07-05" }],
  });
  assert.equal(plan.minBalance, 200); // dipped to 200 before the deposit landed
  assert.equal(plan.requiredTransfer, 800);
});

test("projectOutflows expands monthly/weekly cadences and clamps end-of-month", async () => {
  await addObligation({ name: "Rent", amount: 2400, cadence: "monthly", dueDay: 31 }); // end of month
  await addObligation({ name: "BrightHorizons", amount: 300, cadence: "weekly", dueWeekday: 4 }); // Thursday
  // window: Mon Jun 29 2026 .. Tue Jul 7 2026
  const { outflows } = projectOutflows(await listObligations(), {
    now: new Date("2026-06-29T12:00:00-07:00"), throughDate: "2026-07-07",
  });
  const rent = outflows.filter((o) => o.name === "Rent");
  assert.deepEqual(rent.map((o) => o.date), ["2026-06-30"], "June rent clamps to the 30th (no 31st)");
  const bh = outflows.filter((o) => o.name === "BrightHorizons");
  assert.deepEqual(bh.map((o) => o.date), ["2026-07-02"], "the one Thursday in the window");
});

test("variable obligations are reported as missing until an amount is supplied", async () => {
  await addObligation({ name: "Credit card payment", cadence: "monthly", dueDay: 6, variable: true });
  const obs = await listObligations();
  const noAmt = projectOutflows(obs, { now: new Date("2026-06-29T12:00:00-07:00"), throughDate: "2026-07-10" });
  assert.equal(noAmt.outflows.length, 0);
  assert.equal(noAmt.missing[0].name, "Credit card payment");

  const withAmt = projectOutflows(obs, {
    now: new Date("2026-06-29T12:00:00-07:00"), throughDate: "2026-07-10",
    amounts: { "credit card payment": 890 },
  });
  assert.equal(withAmt.missing.length, 0);
  assert.equal(withAmt.outflows[0].amount, 890);
  assert.equal(withAmt.outflows[0].date, "2026-07-06");
});

test("addObligation upserts by name and validates cadence fields", async () => {
  const a = await addObligation({ name: "Rent", amount: 2400, cadence: "monthly", dueDay: 31 });
  const b = await addObligation({ name: "rent", amount: 2500, cadence: "monthly", dueDay: 31 }); // same name, new amount
  assert.equal(a.id, b.id, "upsert keeps the id");
  assert.equal((await listObligations()).length, 1);
  assert.equal((await listObligations())[0].amount, 2500);
  await assert.rejects(() => addObligation({ name: "X", cadence: "monthly" }), /dueDay/);
  await assert.rejects(() => addObligation({ name: "Y", cadence: "weekly", dueWeekday: 9 }), /dueWeekday/);
  await assert.rejects(() => addObligation({ name: "Z", cadence: "monthly", dueDay: 5 }), /amount is required/);
  assert.equal(await removeObligation("Rent"), true); // remove by name
});

test("planCheckingTransfer end-to-end: rent + car + weekly + variable CC", async () => {
  await addObligation({ name: "Rent", amount: 2400, cadence: "monthly", dueDay: 31 });
  await addObligation({ name: "Car payment", amount: 450, cadence: "monthly", dueDay: 30 });
  await addObligation({ name: "BrightHorizons", amount: 300, cadence: "weekly", dueWeekday: 4 });
  await addObligation({ name: "Credit card payment", cadence: "monthly", dueDay: 6, variable: true });

  const now = new Date("2026-06-29T12:00:00-07:00");
  // Without the CC amount, it should flag what it needs (and still compute the rest).
  const partial = await planCheckingTransfer({ currentBalance: 1200, throughDate: "2026-07-08", now });
  assert.ok(partial.missing.some((m) => /credit card/i.test(m.name)));
  assert.match(partial.text, /I still need an amount for: Credit card payment/);

  // With the CC payment supplied, the number folds it in.
  const full = await planCheckingTransfer({ currentBalance: 1200, creditCardPayment: 890, throughDate: "2026-07-08", now });
  assert.equal(full.missing.length, 0);
  // outflows: Jun30 Car 450, Jun30 Rent 2400, Jul2 BH 300, Jul6 CC 890 = 4040, no inflows.
  // balance only falls: lowest = ending = 1200 - 4040 = -2840 on Jul 6; buffer 1000 => transfer 3840
  assert.equal(full.requiredTransfer, 3840);
  assert.equal(full.minBalance, -2840);
  assert.equal(full.minDate, "2026-07-06");
  assert.equal(full.endingBalance, -2840);
  assert.equal(full.buffer, 1000);
  assert.match(full.text, /Shelli should transfer in about \$3,840/);
});

test("biweekly inflow (paycheck) is projected and offsets the transfer", async () => {
  await addObligation({ name: "Rent", amount: 5951.40, cadence: "monthly", dueDay: 1 });
  await addObligation({ name: "Car payment", amount: 1400, cadence: "monthly", dueDay: 1 });
  await addObligation({ name: "BrightHorizons", amount: 509, cadence: "weekly", dueWeekday: 5 });
  await addObligation({ name: "Nic paycheck", amount: 4000, cadence: "biweekly", anchorDate: "2026-06-19", direction: "in" });

  const now = new Date("2026-06-28T12:00:00-07:00");
  const { outflows, inflows } = projectOutflows(await listObligations(), { now, throughDate: "2026-07-31" });
  // paydays from a Jun 19 anchor, every 14 days, within Jun 28..Jul 31: Jul 3, Jul 17, Jul 31
  assert.deepEqual(inflows.map((i) => i.date), ["2026-07-03", "2026-07-17", "2026-07-31"]);
  assert.ok(outflows.length >= 7); // rent, car, 5 Fridays

  const plan = await planCheckingTransfer({ currentBalance: 5401.43, throughDate: "2026-07-31", now });
  // Paychecks total more than the bills, BUT rent+car ($7351.40) hit Jul 1, before the
  // first paycheck (Jul 3). Lowest point = Jul 3 after BrightHorizons, before that day's
  // paycheck: 5401.43 - 7351.40 - 509 = -2458.97. Transfer = 1000 - (-2458.97) = 3459.
  assert.equal(plan.minDate, "2026-07-03");
  assert.equal(plan.requiredTransfer, 3459);
});

test("formatTransferPlan: no-transfer wording", () => {
  const txt = formatTransferPlan(planTransfer({ currentBalance: 9000, buffer: 1000, outflows: [{ name: "Rent", amount: 2400, date: "2026-06-30" }] }));
  assert.match(txt, /No transfer needed/);
});
