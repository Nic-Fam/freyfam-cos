import { test } from "node:test";
import assert from "node:assert";
import { planRxSync, formatRxPlan } from "../src/rx.js";

test("syncs all meds to the latest ready date and holds the earlier ones", () => {
  const plan = planRxSync([
    { name: "Lisinopril", readyDate: "2026-07-01", returnByDate: "2026-07-20" },
    { name: "Metformin", readyDate: "2026-07-10", returnByDate: "2026-07-25" },
    { name: "Atorvastatin", readyDate: "2026-07-05", returnByDate: "2026-07-22" },
  ]);
  assert.equal(plan.feasible, true);
  assert.equal(plan.deliverOn, "2026-07-10"); // latest ready
  assert.deepEqual(plan.hold.map((m) => m.name).sort(), ["Atorvastatin", "Lisinopril"]);
  assert.deepEqual(plan.readyOnTarget.map((m) => m.name), ["Metformin"]);
  assert.equal(plan.conflicts.length, 0);
});

test("flags a med that would be returned to stock before the synced date", () => {
  const plan = planRxSync([
    { name: "EarlyReturn", readyDate: "2026-07-01", returnByDate: "2026-07-06" }, // returned before target
    { name: "LateFill", readyDate: "2026-07-12", returnByDate: "2026-07-30" },
  ]);
  assert.equal(plan.deliverOn, "2026-07-12");
  assert.equal(plan.feasible, false);
  assert.deepEqual(plan.conflicts.map((m) => m.name), ["EarlyReturn"]);
  assert.match(formatRxPlan(plan), /returned to stock/);
});

test("no dated meds -> nothing to sync", () => {
  const plan = planRxSync([{ name: "PRN", readyDate: null }]);
  assert.equal(plan.deliverOn, null);
  assert.equal(plan.feasible, true);
});
