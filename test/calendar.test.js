import { test } from "node:test";
import assert from "node:assert";
import { buildEventPayload, familyDateWindow, reSubject, localDayLabel, buildMailMessage, deleteEvent } from "../src/channels/graph.js";

test("deleteEvent refuses to call Graph without valid refs (guards a no-op DELETE)", async () => {
  await assert.rejects(() => deleteEvent({}), /requires refs/);
  await assert.rejects(() => deleteEvent({ refs: [] }), /requires refs/);
  await assert.rejects(() => deleteEvent({ refs: [{ calendar: "", id: "" }] }), /requires refs/);
});

test("buildMailMessage puts cc/bcc on real Graph recipient fields (the loop-Nic-in fix)", () => {
  const m = buildMailMessage({
    to: "elisha.gonzalez@brighthorizons.com",
    cc: "nic@freyfam.com",
    bcc: "shelli@freyfam.com",
    subject: "Re: Fox Frey support plan follow-up",
    body: "Hi Elisha,",
  });
  assert.deepEqual(m.toRecipients, [{ emailAddress: { address: "elisha.gonzalez@brighthorizons.com" } }]);
  assert.deepEqual(m.ccRecipients, [{ emailAddress: { address: "nic@freyfam.com" } }]);
  assert.deepEqual(m.bccRecipients, [{ emailAddress: { address: "shelli@freyfam.com" } }]);
});

test("buildMailMessage splits comma/semicolon cc strings into separate recipients", () => {
  const m = buildMailMessage({ to: "a@x.com", cc: "nic@freyfam.com, shelli@freyfam.com", subject: "s", body: "b" });
  assert.deepEqual(
    m.ccRecipients.map((r) => r.emailAddress.address),
    ["nic@freyfam.com", "shelli@freyfam.com"]
  );
});

test("buildMailMessage omits cc/bcc keys entirely when not provided", () => {
  const m = buildMailMessage({ to: "a@x.com", subject: "s", body: "b" });
  assert.ok(!("ccRecipients" in m));
  assert.ok(!("bccRecipients" in m));
});

test("buildMailMessage still requires a real to-recipient", () => {
  assert.throws(() => buildMailMessage({ to: "", cc: "nic@freyfam.com", subject: "s", body: "b" }), /no valid recipient/);
});

test("localDayLabel names the weekday from the date so the model never miscomputes it", () => {
  // Jun 27 2026 is a SATURDAY. The bug was the model calling it "Friday" and
  // shifting that day's availability. The label must be authoritative.
  assert.equal(localDayLabel("2026-06-27T15:00:00.0000000"), "Saturday, Jun 27");
  assert.equal(localDayLabel("2026-06-26T08:30:00.0000000"), "Friday, Jun 26");
  assert.equal(localDayLabel("2026-06-28T00:00:00.0000000"), "Sunday, Jun 28");
  // An early-hour start must still land on its own date (no tz rollback).
  assert.equal(localDayLabel("2026-01-15T00:00:00"), "Thursday, Jan 15");
  assert.equal(localDayLabel(undefined), undefined);
  assert.equal(localDayLabel("not-a-date"), undefined);
});

test("reSubject adds Re: once and tolerates blanks", () => {
  assert.equal(reSubject("Fwd: house on Oak St"), "Re: Fwd: house on Oak St");
  assert.equal(reSubject("Re: already"), "Re: already");
  assert.equal(reSubject(""), "Re: your note");
});

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

test("familyDateWindow anchors bounds to Pacific midnight with the DST offset", () => {
  // Summer => PDT (-07:00). Bounds MUST carry the offset or Graph reads them as UTC.
  const w = familyDateWindow(1, new Date("2026-06-21T19:00:00Z"));
  assert.equal(w.startDateTime, "2026-06-21T00:00:00-07:00");
  assert.equal(w.endDateTime, "2026-06-22T00:00:00-07:00");
});

test("familyDateWindow uses the winter offset (PST) when applicable", () => {
  // January => PST (-08:00). Proves DST is reflected in the offset, not hardcoded.
  const w = familyDateWindow(1, new Date("2026-01-15T19:00:00Z"));
  assert.equal(w.startDateTime, "2026-01-15T00:00:00-08:00");
  assert.equal(w.endDateTime, "2026-01-16T00:00:00-08:00");
});

test("familyDateWindow rolls the end date across a month boundary", () => {
  const w = familyDateWindow(7, new Date("2026-06-28T19:00:00Z"));
  assert.equal(w.startDateTime, "2026-06-28T00:00:00-07:00");
  assert.equal(w.endDateTime, "2026-07-05T00:00:00-07:00");
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
