import { test } from "node:test";
import assert from "node:assert";
import {
  subjectsMatch,
  localDayKey,
  findDuplicateEvent,
  eventPatch,
  withFamilyDefaults,
} from "../src/calendar-policy.js";

// All times below are written with an explicit -07:00 (PDT) offset so the tests
// are timezone-stable regardless of the machine running them.
const ev = (subject, start, extra = {}) => ({
  subject,
  start,
  end: extra.end || start,
  refs: [{ calendar: "nic@freyfam.com", id: `id-${subject}` }],
  ...extra,
});

test("subjectsMatch treats a restatement as the same event", () => {
  assert.equal(subjectsMatch("Dentist", "Dentist appointment"), true);
  assert.equal(subjectsMatch("Fox dentist appt", "Dentist for Fox"), true);
  assert.equal(subjectsMatch("Pilates with Zonnie", "Pilates w/ Zonnie!"), true);
});

test("subjectsMatch does NOT merge different events", () => {
  assert.equal(subjectsMatch("Dentist", "Pediatrician"), false);
  assert.equal(subjectsMatch("Dentist", "Dentist billing call with Aetna"), false);
  assert.equal(subjectsMatch("", "Dentist"), false);
});

test("localDayKey returns the family-local day, null on junk", () => {
  assert.equal(localDayKey("2026-08-24T14:00:00-07:00"), "2026-08-24");
  assert.equal(localDayKey("not a date"), null);
});

test("findDuplicateEvent matches same-day, near-time, same-subject events", () => {
  const events = [
    ev("Dentist appointment", "2026-08-24T14:00:00-07:00"),
    ev("Team standup", "2026-08-24T09:00:00-07:00"),
  ];
  const hit = findDuplicateEvent({
    proposed: { subject: "Dentist", start: "2026-08-24T15:30:00-07:00" },
    events,
  });
  assert.ok(hit);
  assert.equal(hit.event.subject, "Dentist appointment");
  assert.match(hit.why, /already on the calendar/);
});

test("findDuplicateEvent ignores a different day, a far-off time, and unrefd events", () => {
  const events = [ev("Dentist appointment", "2026-08-25T14:00:00-07:00")];
  assert.equal(
    findDuplicateEvent({ proposed: { subject: "Dentist", start: "2026-08-24T14:00:00-07:00" }, events }),
    null
  );
  const sameDayFarOff = [ev("Dentist appointment", "2026-08-24T08:00:00-07:00")];
  assert.equal(
    findDuplicateEvent({ proposed: { subject: "Dentist", start: "2026-08-24T18:00:00-07:00" }, events: sameDayFarOff }),
    null
  );
  const noRefs = [{ subject: "Dentist appointment", start: "2026-08-24T14:00:00-07:00", refs: [] }];
  assert.equal(
    findDuplicateEvent({ proposed: { subject: "Dentist", start: "2026-08-24T14:00:00-07:00" }, events: noRefs }),
    null
  );
});

test("findDuplicateEvent picks the closest candidate", () => {
  const events = [
    ev("Dentist A", "2026-08-24T14:00:00-07:00", { subject: "Dentist", refs: [{ calendar: "nic@freyfam.com", id: "far" }] }),
    { subject: "Dentist", start: "2026-08-24T15:00:00-07:00", refs: [{ calendar: "nic@freyfam.com", id: "near" }] },
  ];
  const hit = findDuplicateEvent({ proposed: { subject: "Dentist", start: "2026-08-24T15:15:00-07:00" }, events });
  assert.equal(hit.event.refs[0].id, "near");
});

test("eventPatch returns only what changed, unioning attendees", () => {
  const existing = {
    subject: "Dentist",
    start: "2026-08-24T14:00:00-07:00",
    end: "2026-08-24T15:00:00-07:00",
    location: "Montrose",
    showAs: "busy",
    attendees: ["nic@freyfam.com"],
  };
  const patch = eventPatch(
    {
      subject: "Dentist",
      start: "2026-08-24T15:30:00-07:00",
      end: "2026-08-24T16:30:00-07:00",
      attendees: ["shelli@freyfam.com"],
    },
    existing
  );
  assert.deepEqual(Object.keys(patch).sort(), ["attendees", "end", "start"]);
  assert.deepEqual(patch.attendees, ["nic@freyfam.com", "shelli@freyfam.com"]);
});

test("eventPatch is null when nothing actually changed", () => {
  const existing = {
    subject: "Dentist",
    start: "2026-08-24T14:00:00-07:00",
    end: "2026-08-24T15:00:00-07:00",
    attendees: ["nic@freyfam.com", "shelli@freyfam.com"],
  };
  assert.equal(
    eventPatch(
      { subject: "Dentist", start: "2026-08-24T14:00:00-07:00", end: "2026-08-24T15:00:00-07:00", attendees: ["nic@freyfam.com"] },
      existing
    ),
    null
  );
});

test("withFamilyDefaults invites the spouse and skips the organizer", () => {
  const out = withFamilyDefaults(
    { subject: "Fox checkup", start: "2026-08-22T11:00:00-07:00" }, // a Saturday
    { organizer: "nic@freyfam.com" }
  );
  assert.deepEqual(out.attendees, ["shelli@freyfam.com"]);
});

test("withFamilyDefaults adds work calendars for a weekday daytime event only", () => {
  const weekday = withFamilyDefaults(
    { subject: "Plumber", start: "2026-08-24T11:00:00-07:00" }, // Monday 11am
    { organizer: "nic@freyfam.com" }
  );
  assert.deepEqual(weekday.attendees.slice().sort(), [
    "nicholas.frey@flyerdefense.com",
    "shelli.frey@disney.com",
    "shelli@freyfam.com",
  ]);

  const evening = withFamilyDefaults(
    { subject: "Dinner", start: "2026-08-24T19:00:00-07:00" }, // Monday 7pm
    { organizer: "nic@freyfam.com" }
  );
  assert.deepEqual(evening.attendees, ["shelli@freyfam.com"]);
});

test("withFamilyDefaults keeps caller attendees and never double-adds", () => {
  const out = withFamilyDefaults(
    { subject: "Tour", start: "2026-08-24T11:00:00-07:00", attendees: ["agent@realty.com", "SHELLI@freyfam.com"] },
    { organizer: "nic@freyfam.com" }
  );
  assert.equal(out.attendees.filter((a) => /shelli@freyfam\.com/i.test(a)).length, 1);
  assert.ok(out.attendees.includes("agent@realty.com"));
});

test("familyCalendar:false is the exemption — nobody is auto-invited", () => {
  const out = withFamilyDefaults(
    { subject: "Private block", start: "2026-08-24T11:00:00-07:00", attendees: ["nic@freyfam.com"] },
    { organizer: "nic@freyfam.com", familyCalendar: false }
  );
  assert.deepEqual(out.attendees, ["nic@freyfam.com"]);
});
