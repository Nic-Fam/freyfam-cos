import { test } from "node:test";
import assert from "node:assert";
import { calendarGateDecision } from "../src/calendar-gate.js";

const NIC = "nic@freyfam.com", SHELLI_WORK = "shelli.frey@disney.com", NIC_WORK = "nicholas.frey@flyerdefense.com";
const START = "2026-11-26T00:00:00";

test("personal block from a family member, no conflict -> auto-create", () => {
  const d = calendarGateDecision({ start: START, attendees: [], sourceFrom: NIC });
  assert.equal(d.auto, true);
});

test("family-only invitees (their own work calendars) requested by family -> auto-create", () => {
  const d = calendarGateDecision({ start: START, attendees: [NIC_WORK, SHELLI_WORK], sourceFrom: NIC });
  assert.equal(d.auto, true, d.why);
});

test("an external invitee always gates", () => {
  const d = calendarGateDecision({ start: START, attendees: [NIC, "stranger@example.com"], sourceFrom: NIC });
  assert.equal(d.auto, false);
  assert.match(d.why, /external/);
});

test("invitees but a non-family requester gates", () => {
  const d = calendarGateDecision({ start: START, attendees: [NIC_WORK], sourceFrom: "someone@school.org" });
  assert.equal(d.auto, false);
});

test("a scheduling conflict gates", () => {
  const d = calendarGateDecision({ start: START, attendees: [], sourceFrom: NIC, hasConflict: true });
  assert.equal(d.auto, false);
  assert.match(d.why, /overlaps/);
});

test("no clear date/time gates", () => {
  assert.equal(calendarGateDecision({ start: "whenever", sourceFrom: NIC }).auto, false);
  assert.equal(calendarGateDecision({ start: "", sourceFrom: NIC }).auto, false);
});

test("a personal block auto-creates even without a known sender (e.g. voice)", () => {
  const d = calendarGateDecision({ start: START, attendees: [], sourceFrom: null });
  assert.equal(d.auto, true);
});
