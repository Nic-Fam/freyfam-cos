import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-outage-seen.json");
process.env.HEARTBEAT_SEEN_PATH = TMP;
const o = await import("../src/outage.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("formatDuration rounds to minutes / hours / days", () => {
  assert.equal(o.formatDuration(60 * 1000), "about 1 minute");
  assert.equal(o.formatDuration(45 * 60 * 1000), "about 45 minutes");
  assert.equal(o.formatDuration(3 * 60 * 60 * 1000), "about 3 hours");
  assert.equal(o.formatDuration(3 * 24 * 60 * 60 * 1000), "about 3 days");
});

test("assessGap: missing last-seen is NOT an outage; small gap no, large gap yes", () => {
  const now = new Date("2026-06-24T20:00:00Z");
  assert.deepEqual(o.assessGap(null, now), { wasOffline: false, gapMs: 0 });
  // 10-min gap (normal heartbeat cadence) -> not an outage at the 30-min threshold
  assert.equal(o.assessGap("2026-06-24T19:50:00Z", now).wasOffline, false);
  // 3-hour gap -> outage
  assert.equal(o.assessGap("2026-06-24T17:00:00Z", now).wasOffline, true);
});

test("setLastSeen / getLastSeen round-trip", async () => {
  assert.equal(await o.getLastSeen(), null); // nothing yet
  await o.setLastSeen(new Date("2026-06-24T20:00:00.000Z"));
  assert.equal(await o.getLastSeen(), "2026-06-24T20:00:00.000Z");
});

test("checkOutageOnBoot notifies only after a real gap, with a back-online message", async () => {
  const sent = [];
  const notify = async (m) => sent.push(m);

  // No prior last-seen (first boot ever) -> no notice.
  let r = await o.checkOutageOnBoot({ now: new Date("2026-06-24T20:00:00Z"), notify });
  assert.equal(r.wasOffline, false);
  assert.equal(sent.length, 0);

  // Last seen 3h ago -> offline notice sent.
  await o.setLastSeen(new Date("2026-06-24T17:00:00Z"));
  r = await o.checkOutageOnBoot({ now: new Date("2026-06-24T20:00:00Z"), notify });
  assert.equal(r.wasOffline, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /back online/i);
  assert.match(sent[0], /about 3 hours/);

  // Last seen 5 min ago (normal restart) -> no notice.
  await o.setLastSeen(new Date("2026-06-24T19:55:00Z"));
  r = await o.checkOutageOnBoot({ now: new Date("2026-06-24T20:00:00Z"), notify });
  assert.equal(r.wasOffline, false);
  assert.equal(sent.length, 1);
});
