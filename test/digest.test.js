import { test } from "node:test";
import assert from "node:assert";
import { shouldRunDigest, runMorningDigest } from "../src/digest.js";

const TZ = "America/Los_Angeles";
const opts = { hour: 7, tz: TZ, windowHours: 2 };

test("fires once inside the morning window when it hasn't run today", () => {
  // 15:00 UTC = 8:00 AM PDT (June) — inside [7,9).
  const r = shouldRunDigest(new Date("2026-06-21T15:00:00Z"), null, opts);
  assert.equal(r.run, true);
  assert.equal(r.date, "2026-06-21");
});

test("does not fire before the window", () => {
  // 12:00 UTC = 5:00 AM PDT — before 7.
  assert.equal(shouldRunDigest(new Date("2026-06-21T12:00:00Z"), null, opts).run, false);
});

test("does not fire after the window (no stale afternoon digest)", () => {
  // 22:00 UTC = 3:00 PM PDT — past 7+2.
  assert.equal(shouldRunDigest(new Date("2026-06-21T22:00:00Z"), null, opts).run, false);
});

test("does not fire twice on the same local day", () => {
  const at = new Date("2026-06-21T15:30:00Z");
  assert.equal(shouldRunDigest(at, "2026-06-21", opts).run, false);
});

test("fires again the next local day", () => {
  const nextDay = new Date("2026-06-22T15:00:00Z");
  const r = shouldRunDigest(nextDay, "2026-06-21", opts);
  assert.equal(r.run, true);
  assert.equal(r.date, "2026-06-22");
});

test("runMorningDigest composes via the runner and delivers the text", async () => {
  const calls = { runner: 0, sent: null };
  const text = await runMorningDigest({
    runner: async (prompt) => {
      calls.runner++;
      assert.match(prompt, /MORNING DIGEST/);
      return "Good morning. 2 events today; salmon for dinner.";
    },
    notify: async (t) => {
      calls.sent = t;
    },
  });
  assert.equal(calls.runner, 1);
  assert.equal(calls.sent, "Good morning. 2 events today; salmon for dinner.");
  assert.equal(text, "Good morning. 2 events today; salmon for dinner.");
});

test("runMorningDigest sends nothing when the digest is empty", async () => {
  let sent = false;
  await runMorningDigest({ runner: async () => "   ", notify: async () => { sent = true; } });
  assert.equal(sent, false);
});
