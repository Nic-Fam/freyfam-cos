import test from "node:test";
import assert from "node:assert";
import { tierFor, tierFloorUsd, cycleStart, cycleKey, braveOverageUsd } from "../src/cost.js";

// Defaults from config: threshold $100, step $50.

test("tierFor is 0 below the threshold and 1 at/above it", () => {
  assert.equal(tierFor(0), 0);
  assert.equal(tierFor(99.99), 0);
  assert.equal(tierFor(100), 1);
  assert.equal(tierFor(149.99), 1);
});

test("tierFor escalates one tier per step past the threshold", () => {
  assert.equal(tierFor(150), 2);
  assert.equal(tierFor(200), 3);
  assert.equal(tierFor(212.34), 3);
  assert.equal(tierFor(250), 4);
});

test("tierFloorUsd maps a tier back to its dollar floor", () => {
  assert.equal(tierFloorUsd(0), 0);
  assert.equal(tierFloorUsd(1), 100);
  assert.equal(tierFloorUsd(2), 150);
  assert.equal(tierFloorUsd(3), 200);
});

test("explicit threshold/step override the defaults", () => {
  assert.equal(tierFor(50, 50, 25), 1);
  assert.equal(tierFor(75, 50, 25), 2);
  assert.equal(tierFloorUsd(2, 50, 25), 75);
});

test("cycle resets on the 1st by default (calendar month, UTC)", () => {
  assert.equal(cycleKey(new Date("2026-06-19T12:00:00Z")), "2026-06");
  assert.equal(cycleStart(new Date("2026-06-19T12:00:00Z")).toISOString(), "2026-06-01T00:00:00.000Z");
});

test("a custom cycleDay rolls the cycle back when before that day", () => {
  // Cycle starts on the 15th. The 10th still belongs to the prior cycle.
  assert.equal(cycleKey(new Date("2026-06-10T00:00:00Z"), 15), "2026-05");
  assert.equal(cycleKey(new Date("2026-06-20T00:00:00Z"), 15), "2026-06");
});

test("braveOverageUsd bills only queries above the included quota, per 1k", () => {
  assert.equal(braveOverageUsd(0, 2000, 5), 0);
  assert.equal(braveOverageUsd(2000, 2000, 5), 0); // exactly at quota -> no overage
  assert.equal(braveOverageUsd(3000, 2000, 5), 5); // 1000 over * $5/1k
  assert.equal(braveOverageUsd(2500, 2000, 5), 2.5);
});
