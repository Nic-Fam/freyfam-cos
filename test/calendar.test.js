import { test } from "node:test";
import assert from "node:assert";
import { buildEventPayload } from "../src/channels/graph.js";

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
