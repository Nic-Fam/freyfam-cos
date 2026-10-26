import { test } from "node:test";
import assert from "node:assert";
import { summarizeLeg, formatCommute, zonedInstant, rfc3339InTz, routeLeg, getCommuteTime } from "../src/commute.js";

test("summarizeLeg converts a route summary to minutes/miles/delay", () => {
  const r = summarizeLeg({ travelTimeInSeconds: 1290, trafficDelayInSeconds: 0, lengthInMeters: 24943 });
  assert.deepEqual(r, { minutes: 22, delayMins: 0, distanceMiles: 15.5, trafficLabel: "light traffic" });
});

test("summarizeLeg labels moderate and heavy traffic by delay", () => {
  assert.equal(summarizeLeg({ travelTimeInSeconds: 600, trafficDelayInSeconds: 360, lengthInMeters: 8000 }).trafficLabel, "moderate traffic");
  assert.equal(summarizeLeg({ travelTimeInSeconds: 600, trafficDelayInSeconds: 1200, lengthInMeters: 8000 }).trafficLabel, "heavy traffic");
});

test("formatCommute shows delay only when present", () => {
  assert.equal(formatCommute({ minutes: 22, delayMins: 0, distanceMiles: 15.5, trafficLabel: "light traffic" }), "22 min (15.5 mi), light traffic");
  assert.equal(formatCommute({ minutes: 35, delayMins: 12, distanceMiles: 9.2, trafficLabel: "moderate traffic" }), "35 min (9.2 mi), moderate traffic (+12 min vs. empty roads)");
});

// --- time-aware routing (2026-10-26) -----------------------------------------
const TZ = "America/Los_Angeles";

test("summarizeLeg measures delay against free-flow time when reported (future routes have trafficDelay 0)", () => {
  const r = summarizeLeg({ travelTimeInSeconds: 2400, trafficDelayInSeconds: 0, noTrafficTravelTimeInSeconds: 1500, lengthInMeters: 16093 });
  assert.equal(r.minutes, 40);
  assert.equal(r.delayMins, 15);
  assert.equal(r.trafficLabel, "heavy traffic");
});

test("zonedInstant treats wall-clock as family time, across DST", () => {
  assert.equal(zonedInstant("2026-10-27T09:30", TZ).toISOString(), "2026-10-27T16:30:00.000Z"); // PDT
  assert.equal(zonedInstant("2026-11-03T09:30:00.0000000", TZ).toISOString(), "2026-11-03T17:30:00.000Z"); // PST
  assert.equal(zonedInstant("2026-10-27T09:30:00Z", TZ).toISOString(), "2026-10-27T09:30:00.000Z", "explicit Z is honored");
  assert.equal(zonedInstant("nope", TZ), null);
});

test("rfc3339InTz renders the family offset", () => {
  assert.equal(rfc3339InTz(new Date("2026-10-27T16:30:00Z"), TZ), "2026-10-27T09:30:00-07:00");
  assert.equal(rfc3339InTz(new Date("2026-12-01T17:30:00Z"), TZ), "2026-12-01T09:30:00-08:00");
});

function fakeMaps({ rejectArriveAt = false, travel = 2400, freeFlow = 1500 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/search/address/")) return { ok: true, json: async () => ({ results: [{ position: { lat: 34.2, lon: -118.2 + calls.length * 0.01 } }] }) };
    if (rejectArriveAt && url.includes("arriveAt=")) return { ok: false, status: 400, json: async () => ({}) };
    const m = url.match(/(arriveAt|departAt)=([^&]+)/);
    const at = m ? new Date(decodeURIComponent(m[2])) : new Date("2026-10-27T13:00:00Z");
    const dep = m && m[1] === "arriveAt" ? new Date(at.getTime() - travel * 1000) : at;
    return { ok: true, json: async () => ({ routes: [{ legs: [{ summary: {
      travelTimeInSeconds: travel, noTrafficTravelTimeInSeconds: freeFlow, trafficDelayInSeconds: 0, lengthInMeters: 20000,
      departureTime: dep.toISOString(), arrivalTime: new Date(dep.getTime() + travel * 1000).toISOString(),
    } }] }] }) };
  };
  return { calls, fetchImpl };
}

test("routeLeg asks Azure for arrive-by routing on predicted traffic and returns the leave time", async () => {
  const { calls, fetchImpl } = fakeMaps();
  const now = new Date("2026-10-27T13:00:00Z"); // 6:00 AM PDT
  const r = await routeLeg("home addr A", "work addr B", { arriveAt: new Date("2026-10-27T16:00:00Z"), key: "k", fetchImpl, now, tz: TZ });
  const routeUrl = calls.find((u) => u.includes("/route/directions/"));
  assert.match(routeUrl, /arriveAt=2026-10-27T09%3A00%3A00-07%3A00/);
  assert.match(routeUrl, /computeTravelTimeFor=all/);
  assert.equal(r.basis, "predicted");
  assert.equal(r.minutes, 40);
  assert.equal(r.departAt.toISOString(), "2026-10-27T15:20:00.000Z"); // 8:20 AM
  assert.equal(r.trafficLabel, "heavy traffic");
});

test("routeLeg falls back to two departAt passes if arriveAt is rejected", async () => {
  const { calls, fetchImpl } = fakeMaps({ rejectArriveAt: true });
  const now = new Date("2026-10-27T13:00:00Z");
  const arrive = new Date("2026-10-27T16:00:00Z");
  const r = await routeLeg("home addr C", "work addr D", { arriveAt: arrive, key: "k", fetchImpl, now, tz: TZ });
  assert.equal(calls.filter((u) => u.includes("departAt=")).length, 2);
  assert.equal(r.arriveAt.getTime(), arrive.getTime());
  assert.equal(r.departAt.toISOString(), "2026-10-27T15:20:00.000Z");
});

test("a time already past is priced as leaving now on live traffic", async () => {
  const { calls, fetchImpl } = fakeMaps();
  const now = new Date("2026-10-27T16:00:00Z");
  const r = await routeLeg("home addr E", "work addr F", { arriveAt: new Date("2026-10-27T16:01:00Z"), key: "k", fetchImpl, now, tz: TZ });
  assert.equal(r.basis, "live");
  assert.ok(!calls.some((u) => /arriveAt=|departAt=/.test(u)));
});

test("getCommuteTime takes a family-local arriveBy", async () => {
  const { calls, fetchImpl } = fakeMaps();
  await getCommuteTime("home addr G", "work addr H", { arriveBy: "2099-10-27T09:00", key: "k", fetchImpl });
  assert.ok(calls.some((u) => u.includes("arriveAt=2099-10-27T09%3A00%3A00-07%3A00")));
});

test("geocode falls back to fuzzy (place-name) search when the address search finds nothing", async () => {
  const { geocode } = await import("../src/commute.js");
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes("/search/address/")) return { ok: true, json: async () => ({ results: [] }) };
    return { ok: true, json: async () => ({ results: [{ position: { lat: 34.15, lon: -118.25 } }] }) };
  };
  const pos = await geocode("Glendale Dental (unique test name)", "k", fetchImpl);
  assert.deepEqual(pos, { lat: 34.15, lon: -118.25 });
  assert.ok(urls[1].includes("/search/fuzzy/"));
});
