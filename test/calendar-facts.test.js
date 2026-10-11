import { test } from "node:test";
import assert from "node:assert";
import {
  wallClock, todayISO, addMinutes, describeEventTime, eventFacts,
  checkWeekday, isBeforeToday, dateReference, personsFor,
} from "../src/calendar-facts.js";

const TZ = "America/Los_Angeles";

test("wallClock reads the literal wall-clock date/time and its weekday, server-tz independent", () => {
  const w = wallClock("2026-10-14T14:30:00");
  assert.equal(w.date, "2026-10-14");
  assert.equal(w.h, 14);
  assert.equal(w.mi, 30);
  assert.equal(w.dow, 3, "Oct 14 2026 is a Wednesday");
  assert.equal(wallClock("2026-10-14").hasTime, false);
  assert.equal(wallClock("not a date"), null);
  assert.equal(wallClock("2026-13-01"), null, "bad month rejected");
});

test("todayISO uses the family timezone, not UTC", () => {
  // 03:00Z on the 12th is still the evening of the 11th in Los Angeles.
  assert.equal(todayISO(new Date("2026-10-12T03:00:00Z"), TZ), "2026-10-11");
});

test("addMinutes defaults a duration and carries across midnight", () => {
  assert.equal(addMinutes("2026-10-14T14:00:00", 60), "2026-10-14T15:00:00");
  assert.equal(addMinutes("2026-10-14T23:30:00", 60), "2026-10-15T00:30:00");
  assert.equal(addMinutes("2026-10-14", 60), "2026-10-14", "date-only (all-day) is left alone");
});

test("describeEventTime gives the authoritative weekday a human can sanity-check", () => {
  assert.equal(describeEventTime("2026-10-14T14:00:00", "2026-10-14T15:00:00"), "Wednesday, Oct 14, 2:00 PM - 3:00 PM");
  assert.equal(describeEventTime("2026-10-14T09:05:00"), "Wednesday, Oct 14, 9:05 AM");
  assert.equal(describeEventTime("2026-10-14"), "Wednesday, Oct 14 (all day)");
});

test("eventFacts judges the workday by the EVENT's time, not the current time", () => {
  const tue2pm = eventFacts("2026-10-13T14:00:00");
  assert.equal(tue2pm.weekday, "Tuesday");
  assert.equal(tue2pm.isWorkday, true);
  assert.equal(tue2pm.duringWorkHours, true);
  assert.equal(eventFacts("2026-10-13T19:00:00").duringWorkHours, false, "evening is outside work hours");
  assert.equal(eventFacts("2026-10-17T14:00:00").isWorkday, false, "Saturday is not a workday");
});

test("checkWeekday catches the 'wrong day of the week' slip and names the right dates", () => {
  assert.equal(checkWeekday("2026-10-13T14:00:00", "Tuesday"), null, "consistent -> no complaint");
  assert.equal(checkWeekday("2026-10-13T14:00:00", "tue"), null, "abbreviations accepted");
  assert.equal(checkWeekday("2026-10-13T14:00:00", undefined), null, "no claim -> nothing to check");
  const msg = checkWeekday("2026-10-14T14:00:00", "Tuesday", { today: "2026-10-11" });
  assert.match(msg, /2026-10-14 is a Wednesday, not a Tuesday/);
  assert.match(msg, /upcoming Tuesdays are 2026-10-13 and 2026-10-20/);
  assert.equal(checkWeekday("2026-10-14T14:00:00", "Funday"), null, "unrecognised weekday never blocks");
});

test("isBeforeToday flags a past date (e.g. the wrong year)", () => {
  assert.equal(isBeforeToday("2025-10-14T14:00:00", "2026-10-11"), true);
  assert.equal(isBeforeToday("2026-10-11T08:00:00", "2026-10-11"), false, "today is fine");
  assert.equal(isBeforeToday("2026-10-20T08:00:00", "2026-10-11"), false);
});

test("dateReference is a correct 3-week lookup table starting today", () => {
  const ref = dateReference(new Date("2026-10-11T18:00:00Z"), TZ); // Sunday in LA
  const lines = ref.split("\n").slice(1);
  assert.equal(lines.length, 21);
  assert.equal(lines[0], "Sun Oct 11 = 2026-10-11 (today)");
  assert.equal(lines[1], "Mon Oct 12 = 2026-10-12 (tomorrow)");
  assert.equal(lines[2], "Tue Oct 13 = 2026-10-13");
  assert.equal(lines[20], "Sat Oct 31 = 2026-10-31");
  assert.match(ref, /never compute them yourself/);
});

test("personsFor maps invitees to whose time they take", () => {
  assert.deepEqual(personsFor(["shelli.frey@disney.com"]), ["shelli"]);
  assert.deepEqual(personsFor(["nicholas.frey@flyerdefense.com", "shelli@freyfam.com"]).sort(), ["nic", "shelli"]);
  assert.deepEqual(personsFor(["dentist@example.com"]), []);
  assert.deepEqual(personsFor("NIC@freyfam.com; foxsfrey@gmail.com").sort(), ["fox", "nic"]);
});
