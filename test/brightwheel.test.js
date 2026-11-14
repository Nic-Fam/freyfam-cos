import { test } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSignInWall,
  isDeviceChallenge,
  pickStudent,
  classifyKind,
  isNotable,
  parseDateHeader,
  parseFeedText,
  entryKey,
  foldDay,
  groupByDate,
  composeUpdate,
  shouldRunBrightwheel,
  getBrightwheelState,
  setBrightwheelState,
  runBrightwheelPull,
} from "../src/brightwheel.js";

const NOW = new Date("2026-08-23T05:30:00-07:00"); // a Sunday, inside the 5am window
const TZ = "America/Los_Angeles";

// --- auth walls -------------------------------------------------------------

test("isSignInWall recognizes Brightwheel auth pages, not app pages", () => {
  assert.ok(isSignInWall("https://schools.mybrightwheel.com/sign-in"));
  assert.ok(isSignInWall("https://schools.mybrightwheel.com/forgot-password"));
  assert.ok(isSignInWall("https://schools.mybrightwheel.com/sign-up"));
  assert.ok(!isSignInWall("https://schools.mybrightwheel.com/students/abc-123/feed"));
  assert.ok(!isSignInWall("https://schools.mybrightwheel.com/"));
  assert.ok(!isSignInWall(null));
});

test("isDeviceChallenge catches the post-password code prompt", () => {
  assert.ok(isDeviceChallenge("Enter the code we emailed you"));
  assert.ok(isDeviceChallenge("Verify your device to continue"));
  assert.ok(!isDeviceChallenge("Fox had a great day painting"));
});

// --- student discovery ------------------------------------------------------

test("pickStudent prefers the child by name, else the first student link", () => {
  const anchors = [
    { href: "https://schools.mybrightwheel.com/messages", text: "Messages" },
    { href: "https://schools.mybrightwheel.com/students/aaa-111/feed", text: "Willa Frey" },
    { href: "https://schools.mybrightwheel.com/students/bbb-222/feed", text: "Fox Frey" },
  ];
  assert.equal(pickStudent(anchors, "Fox").id, "bbb-222");
  assert.equal(pickStudent(anchors, "Nobody").id, "aaa-111"); // falls back, never null when links exist
  assert.equal(pickStudent([{ href: "/messages", text: "Messages" }], "Fox"), null);
  assert.equal(pickStudent([], "Fox"), null);
});

// --- classification ---------------------------------------------------------

test("classifyKind puts specific kinds ahead of the generic note", () => {
  assert.equal(classifyKind("Incident report: bumped his head on the slide"), "incident");
  assert.equal(classifyKind("Please bring a swimsuit Thursday for water day"), "announcement");
  assert.equal(classifyKind("Lunch: chicken, rice, broccoli"), "meal");
  assert.equal(classifyKind("Slept 1h 20m"), "nap");
  assert.equal(classifyKind("Diaper - wet"), "bathroom");
  assert.equal(classifyKind("Checked in by Nic"), "checkin");
  assert.equal(classifyKind("Circle time and finger painting"), "learning");
  assert.equal(classifyKind("Added 3 photos"), "photo");
  assert.equal(classifyKind("He was in a great mood all morning"), "note");
});

test("isNotable pushes injuries/messages/announcements only", () => {
  assert.ok(isNotable("incident"));
  assert.ok(isNotable("announcement"));
  assert.ok(isNotable("message"));
  assert.ok(!isNotable("photo"));
  assert.ok(!isNotable("bathroom"));
});

// --- date headers -----------------------------------------------------------

test("parseDateHeader handles Today/Yesterday/named/slashed forms", () => {
  assert.equal(parseDateHeader("Today", NOW, TZ), "2026-08-23");
  assert.equal(parseDateHeader("Yesterday", NOW, TZ), "2026-08-22");
  assert.equal(parseDateHeader("Friday, August 21", NOW, TZ), "2026-08-21");
  assert.equal(parseDateHeader("Aug 20, 2026", NOW, TZ), "2026-08-20");
  assert.equal(parseDateHeader("8/19/2026", NOW, TZ), "2026-08-19");
  assert.equal(parseDateHeader("8/19", NOW, TZ), "2026-08-19");
});

test("parseDateHeader rejects ordinary feed content", () => {
  assert.equal(parseDateHeader("Lunch: chicken, rice, broccoli", NOW, TZ), null);
  assert.equal(parseDateHeader("", NOW, TZ), null);
  assert.equal(parseDateHeader("A very long line of teacher prose that goes on past the header limit", NOW, TZ), null);
});

// --- feed parsing -----------------------------------------------------------

const FEED = `
Home
Feed
Messages
Today
8:05 AM Checked in by Nic
9:30 AM Theme: Colors
9:35 AM Circle time, then finger painting with red and yellow
11:45 AM Lunch: chicken, rice, broccoli
12:30 PM Nap - slept 1h 20m
1:15 PM Diaper - wet
2:00 PM Added 3 photos
3:10 PM Reminder: please bring a swimsuit Thursday for water day
Yesterday
9:00 AM Sensory bin with dry beans
11:45 AM Lunch: turkey sandwich and apples
1:00 PM Incident report: bumped his head on the slide, ice applied, no marks
`;

test("parseFeedText attributes entries to the right day and kind", () => {
  const entries = parseFeedText(FEED, { now: NOW, tz: TZ, maxEntries: 300 });
  const today = entries.filter((e) => e.date === "2026-08-23");
  const yday = entries.filter((e) => e.date === "2026-08-22");
  assert.equal(today.length, 8);
  assert.equal(yday.length, 3);
  // nav chrome ("Home"/"Feed"/"Messages") is dropped, not stored as activity
  assert.ok(!entries.some((e) => /^(Home|Feed|Messages)$/i.test(e.text)));
  const paint = today.find((e) => /finger painting/i.test(e.text));
  assert.equal(paint.time, "9:35 AM");
  assert.equal(paint.kind, "learning");
  assert.equal(yday.find((e) => /bumped his head/i.test(e.text)).kind, "incident");
});

test("parseFeedText honors maxEntries", () => {
  assert.equal(parseFeedText(FEED, { now: NOW, tz: TZ, maxEntries: 4 }).length, 4);
});

test("entryKey is stable and distinguishes days", () => {
  const a = { date: "2026-08-23", time: "9:35 AM", kind: "learning", text: "finger painting" };
  assert.equal(entryKey(a), entryKey({ ...a }));
  assert.notEqual(entryKey(a), entryKey({ ...a, date: "2026-08-22" }));
});

// --- folding to a fox day ---------------------------------------------------

test("foldDay pulls activities, meals and theme; skips logs the digest doesn't need", () => {
  const entries = parseFeedText(FEED, { now: NOW, tz: TZ, maxEntries: 300 });
  const day = foldDay(groupByDate(entries).get("2026-08-23"));
  assert.equal(day.themeOrUnit, "Colors");
  assert.match(day.activities, /finger painting/);
  assert.match(day.meals.lunch, /chicken, rice, broccoli/);
  // nap + diaper logs are not "activities" — they'd pollute the wardrobe hint
  assert.ok(!/slept|Diaper/i.test(day.activities));
});

test("foldDay dedupes repeated cards and survives an empty day", () => {
  const dup = [
    { date: "d", time: "", kind: "learning", text: "water play" },
    { date: "d", time: "", kind: "learning", text: "water play" },
  ];
  assert.equal(foldDay(dup).activities, "water play");
  assert.deepEqual(foldDay([]), { activities: "", themeOrUnit: "", meals: {} });
});

// --- owner update -----------------------------------------------------------

test("composeUpdate reports only notable items, nothing for a routine day", () => {
  const entries = parseFeedText(FEED, { now: NOW, tz: TZ, maxEntries: 300 });
  const text = composeUpdate(entries);
  assert.match(text, /bumped his head/);
  assert.match(text, /swimsuit Thursday/);
  assert.ok(!/Diaper|Added 3 photos/.test(text));
  assert.equal(composeUpdate([{ date: "d", kind: "photo", text: "Added 3 photos" }]), null);
  assert.equal(composeUpdate([]), null);
});

// --- scheduling + state -----------------------------------------------------

test("shouldRunBrightwheel fires once in the early window", () => {
  const cfg = { hour: 5, windowHours: 3, tz: TZ };
  assert.equal(shouldRunBrightwheel(NOW, null, cfg).run, true);
  assert.equal(shouldRunBrightwheel(NOW, "2026-08-23", cfg).run, false); // already ran today
  const late = new Date("2026-08-23T14:00:00-07:00");
  assert.equal(shouldRunBrightwheel(late, null, cfg).run, false);        // outside the window
});

test("state round-trips and caps the seen ring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-"));
  process.env.BRIGHTWHEEL_STATE_PATH = join(dir, "brightwheel-state.json");
  process.env.BRIGHTWHEEL_MAX_SEEN = "5";
  try {
    assert.deepEqual(await getBrightwheelState(), { lastRunDate: null, seen: [] }); // missing file
    await setBrightwheelState({ lastRunDate: "2026-08-23", seen: ["a", "b"] });
    assert.deepEqual(await getBrightwheelState(), { lastRunDate: "2026-08-23", seen: ["a", "b"] });
    // maxSeen is read from config at import time; assert the file stays bounded
    // by the configured cap rather than the env just set.
    const many = Array.from({ length: 5000 }, (_, i) => `k${i}`);
    await setBrightwheelState({ lastRunDate: "2026-08-23", seen: many });
    const onDisk = JSON.parse(await readFile(process.env.BRIGHTWHEEL_STATE_PATH, "utf8"));
    assert.ok(onDisk.seen.length <= 2000, `seen ring should be capped, got ${onDisk.seen.length}`);
    assert.equal(onDisk.seen.at(-1), "k4999"); // keeps the NEWEST keys
  } finally {
    delete process.env.BRIGHTWHEEL_STATE_PATH;
    delete process.env.BRIGHTWHEEL_MAX_SEEN;
  }
});

// --- the pull ---------------------------------------------------------------

test("runBrightwheelPull stays quiet and saves nothing when not signed in", async () => {
  let saved = 0;
  const r = await runBrightwheelPull({
    fetch: async () => ({ signedIn: false, reason: "no session", entries: [] }),
    save: async () => saved++,
    notify: async () => assert.fail("must not notify when not signed in"),
  });
  assert.deepEqual(r, { signedIn: false, reason: "no session", days: 0, newEntries: 0, notified: false });
  assert.equal(saved, 0);
});

test("runBrightwheelPull saves each day, notifies notable items, then dedupes on the next run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bw-"));
  process.env.BRIGHTWHEEL_STATE_PATH = join(dir, "state.json");
  try {
    const entries = parseFeedText(FEED, { now: NOW, tz: TZ, maxEntries: 300 });
    const fetch = async () => ({ signedIn: true, entries });
    const savedDays = [];
    const notes = [];
    const deps = { fetch, save: async (d, f) => savedDays.push([d, f]), notify: async (t) => notes.push(t) };

    // firstRun: days are saved, but the backlog is NOT blasted at the family
    const first = await runBrightwheelPull({ ...deps, firstRun: true });
    assert.equal(first.days, 2);
    assert.equal(first.notified, false);
    assert.equal(notes.length, 0);
    assert.deepEqual(savedDays.map(([d]) => d).sort(), ["2026-08-22", "2026-08-23"]);

    // second run, same feed: every entry is already seen -> no new items, no send
    const second = await runBrightwheelPull(deps);
    assert.equal(second.newEntries, 0);
    assert.equal(second.notified, false);
    assert.equal(notes.length, 0);

    // a NEW notable card shows up -> exactly that one is reported
    const withNew = [...entries, { date: "2026-08-23", time: "4:00 PM", kind: "message", text: "Ms. Dana: Fox needs more diapers" }];
    const third = await runBrightwheelPull({ ...deps, fetch: async () => ({ signedIn: true, entries: withNew }) });
    assert.equal(third.newEntries, 1);
    assert.equal(third.notified, true);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /needs more diapers/);
  } finally {
    delete process.env.BRIGHTWHEEL_STATE_PATH;
  }
});
