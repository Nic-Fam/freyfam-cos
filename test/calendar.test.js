import { test } from "node:test";
import assert from "node:assert";
import { buildEventPayload, familyDateWindow } from "../src/channels/graph.js";

test("buildEventPayload requires subject + start", () => {
  assert.throws(() => buildEventPayload({ start: "2026-06-25T14:00:00" }), /subject is required/);
  assert.throws(() => buildEventPayload({ subject: "x" }), /start is required/);
});

test("buildEventPayload maps attendees and defaults end + showAs", () => {
  const p = buildEventPayload({
    subject: "Dentist",
    start: "2026-06-25T14:00:00",
    attendees: ["Nicholas.frey@flyerdefense.com", "Shelli.frey@disney.com"],
  });
  assert.equal(p.subject, "Dentist");
  assert.equal(p.showAs, "busy"); // default
  assert.deepEqual(p.end, p.start); // end defaults to start
  assert.deepEqual(
    p.attendees.map((a) => a.emailAddress.address),
    ["Nicholas.frey@flyerdefense.com", "Shelli.frey@disney.com"]
  );
  assert.equal(p.attendees[0].type, "required");
  assert.ok(p.start.dateTime && p.start.timeZone, "start shaped as Graph dateTime");
});

test("familyDateWindow spans [start-of-today, +days] as naive local datetimes", () => {
  // Noon UTC on 6/21 is still 6/21 in America/Los_Angeles (UTC-7), so the day is stable.
  const w = familyDateWindow(1, new Date("2026-06-21T19:00:00Z"));
  assert.equal(w.startDateTime, "2026-06-21T00:00:00");
  assert.equal(w.endDateTime, "2026-06-22T00:00:00");
});

test("familyDateWindow rolls the end date across a month boundary", () => {
  const w = familyDateWindow(7, new Date("2026-06-28T19:00:00Z"));
  assert.equal(w.startDateTime, "2026-06-28T00:00:00");
  assert.equal(w.endDateTime, "2026-07-05T00:00:00");
});

test("buildEventPayload carries showAs=free + location (House Cleaning rule)", () => {
  const p = buildEventPayload({
    subject: "House Cleaning",
    start: "2026-06-26T09:00:00",
    end: "2026-06-26T11:00:00",
    showAs: "free",
    location: "Home",
    attendees: ["Shelli.frey@disney.com"],
  });
  assert.equal(p.showAs, "free");
  assert.equal(p.location.displayName, "Home");
  assert.notDeepEqual(p.end, p.start);
});
