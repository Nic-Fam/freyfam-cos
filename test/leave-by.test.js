import { test } from "node:test";
import assert from "node:assert";
import { computeLeaveBy } from "../src/leave-by.js";

const fakeCommute = (minutes) => async () => ({ minutes, trafficLabel: "light traffic", distanceMiles: 12.3 });

test("leaveBy = arriveBy minus drive minus buffer", async () => {
  const r = await computeLeaveBy({
    origin: "home",
    destination: "151 W 135th St",
    arriveBy: "2026-06-25T14:00:00.000Z",
    bufferMin: 10,
    commute: fakeCommute(35),
  });
  // 14:00 minus 35 min drive minus 10 min buffer = 13:15.
  assert.equal(r.leaveBy, "2026-06-25T13:15:00.000Z");
  assert.equal(r.driveMin, 35);
  assert.equal(r.bufferMin, 10);
});

test("rejects bad input", async () => {
  await assert.rejects(() => computeLeaveBy({ destination: "x", arriveBy: "2026-06-25T14:00:00Z", commute: fakeCommute(10) }), /origin and destination/);
  await assert.rejects(() => computeLeaveBy({ origin: "a", destination: "b", arriveBy: "nope", commute: fakeCommute(10) }), /valid datetime/);
});
