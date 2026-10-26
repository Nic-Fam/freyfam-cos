import { test } from "node:test";
import assert from "node:assert";
import { planDay, priceTrips, formatTripLine, attributeEvent, isAllDayToday, isPhysicalLocation } from "../src/day-plan.js";

const TZ = "America/Los_Angeles";
// Mon Oct 26 2026, 6:00 AM PDT.
const MON = new Date("2026-10-26T13:00:00Z");
// Fri Oct 30 2026 (Shelli's default work-from-home day).
const FRI = new Date("2026-10-30T13:00:00Z");
const SAT = new Date("2026-10-31T13:00:00Z");

const SCHED = {
  tz: TZ,
  workDays: [1, 2, 3, 4, 5],
  daycareDays: [1, 2, 3, 4, 5],
  homeAddress: "1 Home St, La Crescenta, CA",
  daycareAddress: "2 School St, Altadena, CA",
  daycareName: "Woodbury Preschool",
  daycareDropoff: "08:15",
  dropoffDwellMin: 5,
  travelBufferMin: 10,
  people: [
    { name: "Nic", wfhDays: [], chainedDaycare: true, workAddress: "3 Nic Work, Burbank, CA", workStart: "09:00" },
    { name: "Shelli", wfhDays: [5], chainedDaycare: false, workAddress: "4 Shelli Work, Burbank, CA", workStart: "09:00" },
  ],
};
const ev = (subject, start, end, extra = {}) => ({ subject, start, end, showAs: "busy", attendees: [], calendars: ["nic"], ...extra });
const plan = (events, now = MON, sched = SCHED) => planDay({ events, now, tz: TZ, sched, workHours: [8, 18] });

test("a plain weekday follows the weekday rules: both commute, Nic chains drop-off into his work trip", () => {
  const p = plan([]);
  assert.deepEqual(p.people.map((x) => [x.name, x.status]), [["Nic", "in-office"], ["Shelli", "in-office"]]);
  assert.equal(p.daycare.runs, true);
  const nic = p.trips.find((t) => t.who === "Nic");
  assert.equal(nic.to, SCHED.people[0].workAddress);
  assert.equal(nic.via, SCHED.daycareAddress, "drop-off is chained into the commute");
  assert.equal(nic.arriveBy, "2026-10-26T09:00:00");
  assert.deepEqual(p.weatherStops.map((w) => w.label).slice(0, 2), ["Home", "Woodbury Preschool"]);
  assert.deepEqual(p.notes, []);
});

test("PTO on the calendar takes that person off the road", () => {
  const p = plan([ev("Shelli PTO", "2026-10-26T00:00:00", "2026-10-27T00:00:00", { calendars: ["nic"] })]);
  const shelli = p.people.find((x) => x.name === "Shelli");
  assert.equal(shelli.status, "off");
  assert.ok(!p.trips.some((t) => t.who === "Shelli"));
  assert.ok(p.notes.some((n) => /Shelli is off work today/.test(n)));
});

test("a Woodbury closure cancels drop-off and the school day", () => {
  const p = plan([ev("Woodbury closed - staff development day", "2026-10-26T00:00:00", "2026-10-27T00:00:00")]);
  assert.equal(p.daycare.runs, false);
  assert.ok(!p.trips.some((t) => t.via || /drop Fox/.test(t.purpose)));
  assert.ok(!p.weatherStops.some((w) => w.label === "Woodbury Preschool"));
  assert.ok(p.notes.some((n) => /closed today/.test(n)));
});

test("Fox home sick also cancels drop-off", () => {
  const p = plan([ev("Fox sick - staying home", "2026-10-26T00:00:00", "2026-10-27T00:00:00")]);
  assert.equal(p.daycare.runs, false);
});

test("an appointment before work becomes the morning destination, then work follows it", () => {
  const p = plan([ev("Nic dentist", "2026-10-26T08:30:00", "2026-10-26T09:30:00", { location: "Glendale Dental, 100 Brand Blvd, Glendale" })]);
  const nicTrips = p.trips.filter((t) => t.who === "Nic");
  assert.equal(nicTrips[0].purpose, "Nic dentist");
  assert.equal(nicTrips[0].arriveBy, "2026-10-26T08:30:00");
  assert.equal(nicTrips[0].via, SCHED.daycareAddress, "drop-off chained before an 8:30 appointment");
  assert.equal(nicTrips[1].purpose, "work");
  assert.equal(nicTrips[1].from, "Glendale Dental, 100 Brand Blvd, Glendale");
  assert.equal(nicTrips[1].departAfter, "2026-10-26T09:30:00");
});

test("an afternoon appointment for an in-office person is routed from work", () => {
  const p = plan([ev("Shelli doctor", "2026-10-26T15:00:00", "2026-10-26T16:00:00", { location: "Huntington Hospital, Pasadena" })]);
  const t = p.trips.find((x) => x.purpose === "Shelli doctor");
  assert.equal(t.from, SCHED.people[1].workAddress);
});

test("virtual meetings and home locations are not trips", () => {
  const p = plan([
    ev("Nic 1:1", "2026-10-26T10:00:00", "2026-10-26T10:30:00", { location: "Microsoft Teams Meeting" }),
    ev("Nic plumber visit", "2026-10-26T13:00:00", "2026-10-26T14:00:00", { location: "Home" }),
  ]);
  assert.ok(!p.trips.some((t) => /1:1|plumber/.test(t.purpose)));
});

test("Shelli's WFH Friday, but an in-office marker puts her back on the road", () => {
  assert.equal(plan([], FRI).people.find((x) => x.name === "Shelli").status, "home");
  const p = plan([ev("Shelli in office", "2026-10-30T00:00:00", "2026-10-31T00:00:00")], FRI);
  assert.equal(p.people.find((x) => x.name === "Shelli").status, "in-office");
  assert.ok(p.trips.some((t) => t.who === "Shelli" && t.purpose === "work"));
});

test("travel takes a person off the plan, and an unassigned drop-off is flagged", () => {
  const p = plan([ev("Nic flight to DC", "2026-10-26T00:00:00", "2026-10-28T00:00:00")]);
  assert.equal(p.people.find((x) => x.name === "Nic").status, "away");
  assert.ok(p.notes.some((n) => /who is taking Fox/.test(n)));
});

test("weekend: no commutes, but an away-from-home event is still a trip", () => {
  const p = plan([ev("Nic and Shelli: open house", "2026-10-31T13:00:00", "2026-10-31T14:00:00", { location: "500 Fairview Ave, Pasadena" })], SAT);
  assert.equal(p.daycare.runs, false);
  assert.ok(p.people.every((x) => x.status === "home"));
  assert.equal(p.trips.length, 1);
  assert.match(p.trips[0].who, /Nic or Shelli/);
});

test("attributeEvent: subject name beats calendar; ambiguous invitees are shared, never guessed", () => {
  const people = { nic: ["nic@freyfam.com"], shelli: ["shelli@freyfam.com"] };
  assert.deepEqual(attributeEvent({ subject: "Shelli's OBGYN", calendars: ["nic"] }, { parents: ["nic", "shelli"], familyPeople: people }).people, ["shelli"]);
  const amb = attributeEvent({ subject: "Pediatrician", calendars: ["nic"], attendees: ["nic@freyfam.com", "shelli@freyfam.com"] }, { parents: ["nic", "shelli"], familyPeople: people });
  assert.equal(amb.shared, true);
});

test("helpers: all-day detection and physical locations", () => {
  assert.equal(isAllDayToday({ start: "2026-10-26T00:00:00", end: "2026-10-27T00:00:00" }, "2026-10-26"), true);
  assert.equal(isAllDayToday({ start: "2026-10-25T00:00:00", end: "2026-10-28T00:00:00" }, "2026-10-26"), true);
  assert.equal(isAllDayToday({ start: "2026-10-26T09:00:00", end: "2026-10-26T10:00:00" }, "2026-10-26"), false);
  assert.equal(isPhysicalLocation("https://zoom.us/j/1"), false);
  assert.equal(isPhysicalLocation("123 Main St"), true);
  assert.equal(isPhysicalLocation("1 Home St, La Crescenta, CA", "1 Home St, La Crescenta, CA"), false);
});

test("priceTrips: chained drop-off is timed backwards from the destination, and leave-by is real", async () => {
  const p = plan([]);
  const calls = [];
  // Fake router: 20 min home->daycare, 25 min daycare->work, arrive exactly when asked.
  const route = async (from, to, { arriveAt }) => {
    calls.push({ from, to, arriveAt: arriveAt?.toISOString() });
    const minutes = to === SCHED.daycareAddress ? 20 : 25;
    return { minutes, delayMins: 6, trafficLabel: "moderate traffic", basis: "predicted", arriveAt, departAt: new Date(arriveAt.getTime() - minutes * 60000) };
  };
  const priced = await priceTrips(p, { route, now: MON, tz: TZ, dwellMin: 5, daycareDropoff: "08:15" });
  const nic = priced.find((t) => t.who === "Nic");
  // Work 9:00, buffer 10 -> arrive 8:50; leg2 25 min -> leave Woodbury 8:25; drop-off target 8:15
  // is earlier than 8:20 (8:25 minus dwell), so reach Woodbury at 8:15; leg1 20 min -> leave home 7:55.
  assert.equal(nic.leaveAt.toISOString(), "2026-10-26T14:55:00.000Z");
  assert.equal(nic.minutes, 45);
  assert.equal(nic.trafficLabel, "moderate traffic");
  assert.match(formatTripLine(nic, { tz: TZ }), /^Nic: leave home by 7:55 AM for work at 9:00 AM, drop Fox at Woodbury Preschool on the way \(45 min, moderate traffic, 12 min slower than empty roads; predicted for that time\)\.$/);
});

test("priceTrips flags back-to-back commitments that can't both be made", async () => {
  const p = plan([
    ev("Shelli dentist", "2026-10-26T13:00:00", "2026-10-26T14:00:00", { location: "Dentist, Glendale", calendars: ["shelli"] }),
    ev("Shelli school tour", "2026-10-26T14:15:00", "2026-10-26T15:00:00", { location: "Tour School, Pasadena", calendars: ["shelli"] }),
  ]);
  const route = async (from, to, { arriveAt }) => ({ minutes: 30, delayMins: 10, trafficLabel: "moderate traffic", basis: "predicted", arriveAt, departAt: new Date(arriveAt.getTime() - 30 * 60000) });
  const priced = await priceTrips(p, { route, now: MON, tz: TZ });
  const tour = priced.find((t) => t.purpose === "Shelli school tour");
  assert.equal(tour.from, "Dentist, Glendale", "routed from the previous stop");
  assert.match(tour.conflict, /Shelli dentist ends at 2:00 PM, but leaving by 1:35 PM/);
  assert.match(formatTripLine(tour, { tz: TZ }), /TIGHT:/);
});

test("priceTrips never throws: an unroutable trip is reported", async () => {
  const p = plan([]);
  const priced = await priceTrips(p, { route: async () => { throw new Error("Could not geocode"); }, now: MON, tz: TZ });
  assert.ok(priced.every((t) => !t.ok && /geocode/.test(t.error)));
  assert.match(formatTripLine(priced[0], { tz: TZ }), /could not price the drive/);
});
