import { test } from "node:test";
import assert from "node:assert";
import { findConflicts, formatConflicts, shouldRunWeekConflicts } from "../src/week-conflicts.js";

const ev = (subject, start, end, calendars, showAs) => ({ subject, start, end, calendars, showAs });

test("findConflicts flags a same-person double-booking", () => {
  const c = findConflicts([
    ev("Dentist", "2026-07-13T10:00:00", "2026-07-13T11:00:00", ["nic"]),
    ev("Standup", "2026-07-13T10:30:00", "2026-07-13T11:30:00", ["nic"]),
  ]);
  assert.equal(c.length, 1);
  assert.equal(c[0].person, "nic");
});

test("findConflicts ignores cross-person overlaps (both parents busy is not a conflict)", () => {
  const c = findConflicts([
    ev("Dentist", "2026-07-13T10:00:00", "2026-07-13T11:00:00", ["nic"]),
    ev("Meeting", "2026-07-13T10:30:00", "2026-07-13T11:30:00", ["shelli"]),
  ]);
  assert.equal(c.length, 0);
});

test("findConflicts ignores all-day events", () => {
  const c = findConflicts([
    ev("Holiday", "2026-07-13T00:00:00", "2026-07-14T00:00:00", ["nic"]),
    ev("Call", "2026-07-13T10:00:00", "2026-07-13T11:00:00", ["nic"]),
  ]);
  assert.equal(c.length, 0);
});

test("findConflicts ignores free blocks and sub-15min grazes", () => {
  assert.equal(findConflicts([
    ev("Busy", "2026-07-13T10:00:00", "2026-07-13T11:00:00", ["nic"]),
    ev("Free", "2026-07-13T10:00:00", "2026-07-13T12:00:00", ["nic"], "free"),
  ]).length, 0, "free block excluded");
  assert.equal(findConflicts([
    ev("A", "2026-07-13T10:00:00", "2026-07-13T11:05:00", ["nic"]),
    ev("B", "2026-07-13T11:00:00", "2026-07-13T12:00:00", ["nic"]),
  ]).length, 0, "5-min graze excluded");
});

test("formatConflicts: null when clear, a readable line when not", () => {
  assert.equal(formatConflicts([]), null);
  const msg = formatConflicts(
    [{ person: "nic", a: { subject: "A", start: "2026-07-13T10:00:00" }, b: { subject: "B", start: "2026-07-13T10:30:00" } }],
    { tz: "America/Los_Angeles" }
  );
  assert.match(msg, /1 scheduling conflict/);
  assert.match(msg, /Nic:/);
});

test("shouldRunWeekConflicts: Sunday-in-window only, once per day", () => {
  const cfg = { weekday: 0, hour: 17, windowHours: 3, tz: "America/Los_Angeles" };
  const sundayEve = new Date("2026-07-12T17:30:00-07:00"); // Sun Jul 12 2026, 5:30pm PT
  assert.equal(shouldRunWeekConflicts(sundayEve, null, cfg).run, true);
  assert.equal(shouldRunWeekConflicts(sundayEve, "2026-07-12", cfg).run, false, "already ran today");
  assert.equal(shouldRunWeekConflicts(new Date("2026-07-13T17:30:00-07:00"), null, cfg).run, false, "Monday");
  assert.equal(shouldRunWeekConflicts(new Date("2026-07-12T09:00:00-07:00"), null, cfg).run, false, "before window");
});
