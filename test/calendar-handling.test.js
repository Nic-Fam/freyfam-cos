import { test, before, after } from "node:test";
import assert from "node:assert";
import { writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// Config is read at import time, so set the environment FIRST.
const RULES = join(os.tmpdir(), `cos-cal-rules-${process.pid}.json`);
const PEND = join(os.tmpdir(), `cos-cal-pending-${process.pid}.json`);
process.env.FAMILY_PHONES = "+18185550101,+18185550102";
process.env.HOUSE_RULES_PATH = RULES;
process.env.PENDING_APPROVALS_PATH = PEND;

const { isFamilyRequester } = await import("../src/guards.js");
const { calendarGateDecision } = await import("../src/calendar-gate.js");
const { collectPages, mergeCalendarResults } = await import("../src/channels/graph.js");
const { formatHouseRules } = await import("../src/rules.js");
const { _toolHandlersForTest } = await import("../src/orchestrator.js");

before(() => writeFile(RULES, JSON.stringify({
  rules: ["For appointments during the workday, add Nic's work email and Shelli's work email as invitees."],
})));
after(() => Promise.all([rm(RULES, { force: true }), rm(PEND, { force: true })]));

// --- "asked for by the family" across every channel -------------------------

test("isFamilyRequester recognises family on iMessage by phone, not just by email", () => {
  assert.equal(isFamilyRequester({ channel: "imessage", from: "+18185550101" }), true);
  assert.equal(isFamilyRequester({ channel: "imessage", from: "(818) 555-0102" }), true, "formatting-insensitive");
  assert.equal(isFamilyRequester({ channel: "imessage", from: "nic@freyfam.com" }), true, "Apple ID email handle");
  assert.equal(isFamilyRequester({ channel: "imessage", from: "+13105559999" }), false, "an unknown number");
});

test("isFamilyRequester: email by family address, voice trusted, Slack/heartbeat not by default", () => {
  assert.equal(isFamilyRequester({ channel: "email", from: "shelli@freyfam.com" }), true);
  assert.equal(isFamilyRequester({ channel: "email", from: "someone@school.org" }), false);
  assert.equal(isFamilyRequester({ channel: "voice", from: "voice" }), true);
  assert.equal(isFamilyRequester({ channel: "slack", from: "U123" }), false, "Slack needs SLACK_ALLOW");
  assert.equal(isFamilyRequester({ channel: undefined, from: "" }), false, "proactive runs keep the gate");
});

test("the gate auto-creates for a family request over iMessage (it used to always gate)", () => {
  const d = calendarGateDecision({
    start: "2030-01-15T14:00:00",
    attendees: ["nicholas.frey@flyerdefense.com", "shelli.frey@disney.com"],
    sourceFrom: "+18185550101", // a phone: the old email-only check never trusted this
    trustedRequester: true,
  });
  assert.equal(d.auto, true, d.why);
  // ...but outside invitees and clashes still gate, whoever asked.
  assert.equal(calendarGateDecision({ start: "2030-01-15T14:00:00", attendees: ["dentist@example.com"], trustedRequester: true }).auto, false);
  assert.equal(calendarGateDecision({ start: "2030-01-15T14:00:00", attendees: [], trustedRequester: true, hasConflict: true }).auto, false);
});

// --- reads: page to the end, never lose events silently ---------------------

test("collectPages follows every nextLink (it used to stop at the first 50)", async () => {
  const pages = {
    p2: { value: [{ id: 3 }, { id: 4 }], "@odata.nextLink": "p3" },
    p3: { value: [{ id: 5 }] },
  };
  const r = await collectPages({ value: [{ id: 1 }, { id: 2 }], "@odata.nextLink": "p2" }, async (u) => pages[u]);
  assert.deepEqual(r.items.map((x) => x.id), [1, 2, 3, 4, 5]);
  assert.equal(r.complete, true);
});

test("collectPages reports incompleteness when the page bound is hit", async () => {
  const r = await collectPages({ value: [{ id: 1 }], "@odata.nextLink": "x" }, async () => ({ value: [{ id: 2 }], "@odata.nextLink": "x" }), { maxPages: 3 });
  assert.equal(r.items.length, 3);
  assert.equal(r.complete, false);
});

const ev = (subject, start, owner, id) => ({ subject, start, day: start.slice(0, 10), calendars: [owner], refs: [{ calendar: owner, id }] });

test("mergeCalendarResults dedupes a shared event and surfaces unreadable calendars", () => {
  const r = mergeCalendarResults([
    { events: [ev("Dinner", "2030-01-15T18:00:00", "nic", "a")], errors: [] },
    { events: [ev("Dinner", "2030-01-15T18:00:00", "shelli", "b")], errors: ["shelli's \"Work\" calendar could not be read (403)"] },
  ]);
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.events[0].calendars.sort(), ["nic", "shelli"]);
  assert.equal(r.events[0].refs.length, 2);
  assert.match(r.warnings[0], /could not be read/);
});

test("mergeCalendarResults reports truncation instead of silently dropping events", () => {
  const many = Array.from({ length: 5 }, (_, i) => ev(`E${i}`, `2030-01-1${i}T09:00:00`, "nic", `id${i}`));
  const r = mergeCalendarResults([{ events: many, errors: [] }], { cap: 3 });
  assert.equal(r.events.length, 3);
  assert.equal(r.truncated, true);
  assert.equal(r.total, 5);
  assert.match(r.warnings.join(" "), /Only the first 3 of 5 events/);
});

// --- invitee rules judged by the EVENT's time --------------------------------

test("the house-rules header anchors time conditions to the event, not the current time", () => {
  const h = formatHouseRules(["x"]);
  assert.match(h, /judge conditions like 'during the workday' by the EVENT's own date and time/);
  assert.doesNotMatch(h, /use the current time above to judge conditions like 'during the workday'/);
});

// --- the create handler's guards (all run before any Graph call) ------------

const handlers = _toolHandlersForTest({ trustedRequester: true });

test("create_calendar_event rejects a date that isn't the weekday it claims", async () => {
  // 2030-01-16 is a Wednesday.
  const out = await handlers.create_calendar_event({ subject: "Dentist", start: "2030-01-16T14:00:00", weekday: "Tuesday" });
  assert.match(out, /^Not created\. Date\/weekday mismatch: 2030-01-16 is a Wednesday, not a Tuesday/);
});

test("create_calendar_event rejects a past date (the wrong-year slip)", async () => {
  const out = await handlers.create_calendar_event({ subject: "Dentist", start: "2020-01-14T14:00:00", weekday: "Tuesday" });
  assert.match(out, /^Not created: 2020-01-14 is before today/);
});

test("create_calendar_event rejects an unreadable start instead of staging it", async () => {
  const out = await handlers.create_calendar_event({ subject: "Dentist", start: "next tuesday at 2", weekday: "Tuesday" });
  assert.match(out, /couldn't read the start time/);
});

test("a workday-hours event with no work email is sent back to apply the invitee rule", async () => {
  // 2030-01-15 is a Tuesday; 2 PM is inside work hours. The rule file has a workday invitee rule.
  const out = await handlers.create_calendar_event({ subject: "Dentist", start: "2030-01-15T14:00:00", weekday: "Tuesday", attendees: [] });
  assert.match(out, /^Not created yet\. "Dentist" is on Tuesday, Jan 15, 2:00 PM - 3:00 PM, a workday during work hours/);
  assert.match(out, /apply it to THIS event's day and time \(not the current time\)/);
  assert.match(out, /inviteesChecked: true/);
});
