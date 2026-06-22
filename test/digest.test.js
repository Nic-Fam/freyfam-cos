import { test } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { shouldRunDigest, runMorningDigest, buildDigestPrompt, extractDigest, getLastDigestDate, setLastDigestDate } from "../src/digest.js";

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

test("last-digest date persists across calls (survives a restart)", async () => {
  const TMP = join(os.tmpdir(), "cos-digest-state-test.json");
  process.env.DIGEST_STATE_PATH = TMP;
  await rm(TMP, { force: true });
  assert.equal(await getLastDigestDate(), null); // no state yet
  await setLastDigestDate("2026-06-22");
  assert.equal(await getLastDigestDate(), "2026-06-22"); // a fresh process would read this and not re-fire
  await rm(TMP, { force: true });
  delete process.env.DIGEST_STATE_PATH;
});

test("buildDigestPrompt injects the authoritative date as ground truth", () => {
  const p = buildDigestPrompt(new Date("2026-06-21T19:00:00Z"), TZ); // Sunday in PT
  assert.match(p, /Today is Sunday, June 21, 2026 \(2026-06-21\)/);
  assert.match(p, /treat a calendar event dated 2026-06-21 as TODAY/);
  assert.match(p, /<digest> and <\/digest>/);
});

test("extractDigest pulls fenced content and drops any preamble", () => {
  const raw = "Now I have everything I need. Note: today is...\n<digest>Good morning. Clear day.</digest>\ntrailing";
  assert.equal(extractDigest(raw), "Good morning. Clear day.");
});

test("extractDigest falls back to raw text when tags are absent", () => {
  assert.equal(extractDigest("Good morning. Clear day."), "Good morning. Clear day.");
  assert.equal(extractDigest("   "), "");
});

test("runMorningDigest delivers over BOTH sms and email", async () => {
  const calls = { runner: 0, sms: null, mail: null };
  const text = await runMorningDigest({
    runner: async (prompt) => {
      calls.runner++;
      assert.match(prompt, /MORNING DIGEST/);
      return "Good morning. 2 events today; salmon for dinner.";
    },
    notify: async (t) => { calls.sms = t; },
    mail: async (m) => { calls.mail = m; },
  });
  assert.equal(calls.runner, 1);
  assert.equal(calls.sms, "Good morning. 2 events today; salmon for dinner.");
  assert.equal(calls.mail.body, "Good morning. 2 events today; salmon for dinner.");
  assert.ok(Array.isArray(calls.mail.to) && calls.mail.to.length, "email has recipients");
  assert.match(calls.mail.subject, /^Morning digest:/);
  assert.equal(text, "Good morning. 2 events today; salmon for dinner.");
});

test("a failing channel does not block the other", async () => {
  let mailed = false;
  await runMorningDigest({
    runner: async () => "digest body",
    notify: async () => { throw new Error("twilio not cleared"); }, // sms fails
    mail: async () => { mailed = true; }, // email still goes
  });
  assert.equal(mailed, true);
});

test("runMorningDigest sends nothing when the digest is empty", async () => {
  let sent = false;
  await runMorningDigest({ runner: async () => "   ", notify: async () => { sent = true; }, mail: async () => { sent = true; } });
  assert.equal(sent, false);
});
