import { test } from "node:test";
import assert from "node:assert";
import { livenessEntity, stalenessMs, LIVENESS_PARTITION, LIVENESS_ROW } from "../src/liveness.js";

test("livenessEntity carries only liveness metadata (no family content)", () => {
  const now = new Date("2026-06-24T17:00:00.000Z");
  const e = livenessEntity({ now, host: "lloyd-mini.local", pid: 4242 });
  assert.equal(e.partitionKey, LIVENESS_PARTITION);
  assert.equal(e.rowKey, LIVENESS_ROW);
  assert.equal(e.lastSeen, "2026-06-24T17:00:00.000Z");
  assert.equal(e.host, "lloyd-mini.local");
  assert.equal(e.pid, 4242);
  // Exactly these fields — nothing that could leak household data.
  assert.deepEqual(Object.keys(e).sort(), ["host", "lastSeen", "partitionKey", "pid", "rowKey"]);
});

test("livenessEntity tolerates missing host/pid and caps host length", () => {
  const e = livenessEntity({ now: new Date("2026-06-24T17:00:00Z") });
  assert.equal(e.host, "");
  assert.equal(e.pid, 0);
  const long = livenessEntity({ host: "x".repeat(500) });
  assert.equal(long.host.length, 100);
});

test("stalenessMs measures age and treats a bad/missing timestamp as infinitely stale", () => {
  const now = new Date("2026-06-24T17:00:00.000Z");
  assert.equal(stalenessMs("2026-06-24T16:30:00.000Z", now), 30 * 60 * 1000);
  assert.equal(stalenessMs("2026-06-24T17:00:00.000Z", now), 0);
  assert.equal(stalenessMs("not-a-date", now), Infinity);
  assert.equal(stalenessMs(undefined, now), Infinity);
});
