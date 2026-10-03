import { test } from "node:test";
import assert from "node:assert";
import { localWeekday, dayPlan } from "../src/schedule.js";

const TZ = "America/Los_Angeles";
// 19:00Z lands the same local day in PT for all of these.
const at = (iso) => new Date(iso);

test("localWeekday is computed in the family timezone, not UTC", () => {
  // 2026-10-03T19:00Z is Saturday in PT.
  assert.equal(localWeekday(at("2026-10-03T19:00:00Z"), TZ), 6);
  // 2026-10-05T07:00Z is still Sunday evening in PT (UTC would say Monday).
  assert.equal(localWeekday(at("2026-10-05T03:00:00Z"), TZ), 0);
});

test("weekday: everyone out, daycare on", () => {
  const p = dayPlan(at("2026-10-07T16:00:00Z"), TZ); // Wednesday PT
  assert.equal(p.isWeekend, false);
  assert.equal(p.daycare, true);
  assert.equal(p.anyOut, true);
  assert.deepEqual(p.out.map((x) => x.name), ["Nic", "Shelli"]);
  assert.equal(p.out.find((x) => x.name === "Nic").chainedDaycare, true);
  assert.deepEqual(p.home, []);
});

test("Friday: Shelli works from home, Nic still commutes", () => {
  const p = dayPlan(at("2026-10-09T16:00:00Z"), TZ); // Friday PT
  assert.deepEqual(p.out.map((x) => x.name), ["Nic"]);
  assert.deepEqual(p.home.map((x) => x.name), ["Shelli"]);
  assert.match(p.home[0].reason, /works from home/i);
  assert.equal(p.daycare, true, "daycare still runs on Friday");
});

test("weekend: nobody out, no daycare", () => {
  for (const iso of ["2026-10-10T16:00:00Z", "2026-10-11T16:00:00Z"]) { // Sat, Sun PT
    const p = dayPlan(at(iso), TZ);
    assert.equal(p.isWeekend, true);
    assert.equal(p.anyOut, false);
    assert.equal(p.daycare, false);
    assert.deepEqual(p.out, []);
    assert.equal(p.home.length, 2);
    assert.match(p.home[0].reason, /weekend/i);
  }
});

test("schedule is overridable (injected config)", () => {
  const sched = {
    tz: TZ,
    workDays: [1, 2, 3, 4, 5],
    daycareDays: [],
    people: [{ name: "Solo", wfhDays: [3], chainedDaycare: false }],
  };
  const wed = dayPlan(at("2026-10-07T16:00:00Z"), TZ, sched);
  assert.equal(wed.anyOut, false, "WFH Wednesday keeps them home");
  assert.equal(wed.daycare, false, "no daycare days configured");
  const thu = dayPlan(at("2026-10-08T16:00:00Z"), TZ, sched);
  assert.deepEqual(thu.out.map((x) => x.name), ["Solo"]);
});
