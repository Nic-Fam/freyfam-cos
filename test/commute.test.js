import { test } from "node:test";
import assert from "node:assert";
import { summarizeLeg, formatCommute } from "../src/commute.js";

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
  assert.equal(formatCommute({ minutes: 35, delayMins: 12, distanceMiles: 9.2, trafficLabel: "moderate traffic" }), "35 min (9.2 mi), moderate traffic (+12 min delay)");
});
