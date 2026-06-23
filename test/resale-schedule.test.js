import { test } from "node:test";
import assert from "node:assert";
import { dueSlots } from "../src/resale-schedule.js";

const opts = { slots: [{ label: "07:05", minutes: 425 }, { label: "16:05", minutes: 965 }], windowMin: 55, tz: "America/Los_Angeles" };

test("the 7am slot is due just after 7am PT, once per day", () => {
  const at = new Date("2026-06-26T14:10:00Z"); // 07:10 PDT
  const { due, date } = dueSlots(at, {}, opts);
  assert.deepEqual(due.map((d) => d.label), ["07:05"]);
  assert.equal(date, "2026-06-26");
  // already ran this slot today -> not due
  assert.deepEqual(dueSlots(at, { "07:05": "2026-06-26" }, opts).due, []);
});

test("the 4pm slot is due just after 4pm PT", () => {
  const at = new Date("2026-06-26T23:30:00Z"); // 16:30 PDT
  assert.deepEqual(dueSlots(at, {}, opts).due.map((d) => d.label), ["16:05"]);
});

test("nothing is due midday or before a slot", () => {
  assert.deepEqual(dueSlots(new Date("2026-06-26T19:00:00Z"), {}, opts).due, []); // noon PT
  assert.deepEqual(dueSlots(new Date("2026-06-26T13:50:00Z"), {}, opts).due, []); // 06:50 PT, before 7:05
});
