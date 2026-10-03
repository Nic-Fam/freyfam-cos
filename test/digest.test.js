import { test } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { shouldRunDigest, runMorningDigest, buildDigestPrompt, buildDigestContext, extractDigest, getLastDigestDate, setLastDigestDate, getDigestAlertedDate, setDigestAlertedDate } from "../src/digest.js";
import { dayPlan } from "../src/schedule.js";

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

test("buildDigestPrompt asks for anticipated package deliveries", () => {
  const p = buildDigestPrompt(new Date("2026-06-21T19:00:00Z"), TZ);
  assert.match(p, /list_packages/);
  assert.match(p, /package deliveries expected today/i);
});

// --- adaptive sections: only ask for what applies today ---------------------

const WED = new Date("2026-10-07T16:00:00Z"); // Wednesday PT
const FRI = new Date("2026-10-09T16:00:00Z"); // Friday PT
const SAT = new Date("2026-10-10T16:00:00Z"); // Saturday PT

test("weekend digest drops commutes, work-location weather, and daycare entirely", () => {
  const p = buildDigestPrompt(SAT, TZ);
  assert.doesNotMatch(p, /commute_time/, "no commute routing on a weekend");
  assert.doesNotMatch(p, /fox_today/, "no daycare note when daycare is closed");
  assert.doesNotMatch(p, /Woodbury/, "no daycare location at all");
  assert.match(p, /get_weather for HOME only/i, "home weather is still useful");
  assert.match(p, /do NOT include any work commute/i);
});

test("Friday digest routes Nic but not Shelli (she works from home)", () => {
  const p = buildDigestPrompt(FRI, TZ);
  assert.match(p, /Nic: CHAINED trip/, "Nic still has the chained daycare drive");
  assert.doesNotMatch(p, /home to Shelli's work/, "no commute leg for Shelli");
  assert.match(p, /Shelli \(works from home today\)/);
  assert.match(p, /NO commute and NO work-location weather/i);
  assert.match(p, /fox_today/, "daycare still runs on Friday");
});

test("a normal weekday routes both people and includes the daycare leg", () => {
  const p = buildDigestPrompt(WED, TZ);
  assert.match(p, /Nic: CHAINED trip/);
  assert.match(p, /Shelli: call commute_time from home to Shelli's work/);
  assert.match(p, /fox_today/);
});

test("move sale is omitted unless something is still live, and never recaps sold items", () => {
  const quiet = buildDigestPrompt(WED, TZ, { plan: dayPlan(WED, TZ), move: null });
  assert.doesNotMatch(quiet, /Move sale/i, "a finished move must not appear at all");
  assert.doesNotMatch(quiet, /list_downsizing/);

  const live = buildDigestPrompt(WED, TZ, { plan: dayPlan(WED, TZ), move: { active: 3, draft: 2, sold: 7 } });
  assert.match(live, /Move sale: 3 listed and 2 still in draft \(7 sold\)/);
  assert.match(live, /Do not recap items\s+already sold or pulled/);
});

test("buildDigestContext suppresses the move sale once nothing is draft/active", async () => {
  const done = await buildDigestContext(WED, { tz: TZ, moveSummary: async () => ({ active: 0, draft: 0, sold: 12, pulled: 3 }) });
  assert.equal(done.move, null, "all sold/pulled -> section retires itself");

  const live = await buildDigestContext(WED, { tz: TZ, moveSummary: async () => ({ active: 1, draft: 0, sold: 2 }) });
  assert.ok(live.move, "still live -> section stays");
});

test("buildDigestContext survives a store failure", async () => {
  const ctx = await buildDigestContext(WED, { tz: TZ, moveSummary: async () => { throw new Error("store gone"); } });
  assert.equal(ctx.move, null);
  assert.ok(ctx.plan, "the day plan is still computed");
});

test("the digest forbids 'nothing to report' filler and stale completion notices", () => {
  const p = buildDigestPrompt(WED, TZ);
  assert.match(p, /OMIT THE REST/);
  assert.match(p, /"nothing today", no "all clear"/);
  assert.match(p, /Never report that something is already finished/i);
});

test("dinner out weighs BOTH calendars and won't pitch a family dinner for one person", () => {
  const p = buildDigestPrompt(WED, TZ);
  assert.match(p, /FIRST WORK OUT WHO IS ACTUALLY THERE/);
  assert.match(p, /the same event often appears on BOTH Nic's and\s+Shelli's calendars/);
  assert.match(p, /Both Nic and Shelli at it: suggest dinner for the two of them/);
  assert.match(p, /Only ONE of them out: do NOT pitch a dinner out/);
});

test("follow-ups exclude routine, self-completing things (no 'how did the dogs go')", () => {
  const p = buildDigestPrompt(WED, TZ);
  assert.match(p, /BE STRICT ABOUT WHAT EARNS A FOLLOW-UP/);
  assert.match(p, /someone OUTSIDE the household/);
  assert.match(p, /COMPLETE BY HAPPENING/);
  assert.match(p, /dogs are out in the garden/);
  assert.match(p, /Do not ask how any of them\s+went/);
  assert.match(p, /no open follow-ups at all, omit\s+this whole section/);
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
  const r = await runMorningDigest({
    runner: async (prompt) => {
      calls.runner++;
      assert.match(prompt, /MORNING DIGEST/);
      return "Good morning. 2 events today; salmon for dinner.";
    },
    notify: async (t) => { calls.sms = t; return "sent"; },
    mail: async (m) => { calls.mail = m; },
  });
  assert.equal(calls.runner, 1);
  assert.equal(calls.sms, "Good morning. 2 events today; salmon for dinner.");
  assert.equal(calls.mail.body, "Good morning. 2 events today; salmon for dinner.");
  assert.ok(Array.isArray(calls.mail.to) && calls.mail.to.length, "email has recipients");
  assert.match(calls.mail.subject, /^Morning digest:/);
  assert.equal(r.body, "Good morning. 2 events today; salmon for dinner.");
  assert.equal(r.delivered, true);
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
  const r = await runMorningDigest({ runner: async () => "   ", notify: async () => { sent = true; }, mail: async () => { sent = true; } });
  assert.equal(sent, false);
  assert.equal(r.delivered, false);
  assert.equal(r.empty, true);
});

test("digest state keeps lastRunDate and alertedDate independently", async () => {
  const TMP = join(os.tmpdir(), "cos-digest-state-2.json");
  process.env.DIGEST_STATE_PATH = TMP;
  await rm(TMP, { force: true });
  await setLastDigestDate("2026-07-01");
  await setDigestAlertedDate("2026-07-01");
  assert.equal(await getLastDigestDate(), "2026-07-01");
  assert.equal(await getDigestAlertedDate(), "2026-07-01");
  await setLastDigestDate("2026-07-02"); // must not clobber alertedDate
  assert.equal(await getDigestAlertedDate(), "2026-07-01");
  await rm(TMP, { force: true });
  delete process.env.DIGEST_STATE_PATH;
});
