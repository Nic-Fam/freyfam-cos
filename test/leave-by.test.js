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

test("leave-by prices the drive for the trip time (arrive buffer-early), not right now", async () => {
  let asked = null;
  const commute = async (o, d, opts) => {
    asked = opts.arriveBy;
    const arrive = new Date(opts.arriveBy);
    return { minutes: 42, trafficLabel: "heavy traffic", distanceMiles: 14, basis: "predicted", departAt: new Date(arrive.getTime() - 42 * 60000) };
  };
  const r = await computeLeaveBy({ origin: "home", destination: "Glendale", arriveBy: "2026-10-27T17:00:00Z", bufferMin: 10, commute });
  assert.equal(asked, "2026-10-27T16:50:00.000Z", "asks to arrive 10 minutes early");
  assert.equal(r.leaveBy, "2026-10-27T16:08:00.000Z");
  assert.equal(r.basis, "predicted");
});
