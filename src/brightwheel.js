import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { withPage, withHeadedPage } from "./channels/browser.js";
import { assertPublicUrl } from "./net-guard.js";
import { BRIGHTWHEEL } from "./config.js";
import { setFoxDay } from "./fox.js";
import { notifyOwner } from "./channels/notify.js";
import { localParts } from "./digest.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Woodbury Preschool posts Fox's day in BRIGHTWHEEL, not email. Item 005b used to
// wait on a forwarded PDF; this pulls the same content at the source so the
// morning digest keeps working without anyone forwarding anything.
//
// Read-only crawl of the parent web app (schools.mybrightwheel.com) on Lloyd's
// LOCAL signed-in Chrome profile — same contract as amazon-orders.js: Brightwheel
// is behind a login, the Azure specialists have no browser, and the residential
// profile carries the session. Nothing here writes to Brightwheel (no messages,
// no check-in/out), so there is no confirmation gate to apply.
//
// AUTH, in order of preference:
//   1. SESSION (recommended) — the family signs into Brightwheel ONCE in the
//      Chrome profile BROWSER_USER_DATA_DIR points at; the cookie is reused and
//      no password lives on disk. This also sidesteps new-device verification.
//   2. PASSWORD FALLBACK — if BRIGHTWHEEL_USERNAME/BRIGHTWHEEL_PASSWORD are set
//      in .env (provisioned by the family, never by the assistant), a sign-in
//      wall is answered by filling the form. Brightwheel may still demand an
//      emailed device code, in which case we report the wall instead of
//      pretending we scraped a feed.
//
// Anything the crawl finds is UNTRUSTED INPUT (a teacher note is just text, and
// so is anything a stranger could get into the feed). Entries are stored and
// summarized, never executed as instructions — see agents/security.md.
//
// Parsing is TEXT-based over each feed card's innerText rather than pinned to
// Brightwheel's CSS classes, so a class rename degrades a field instead of
// silently blanking the day. The URL/anchor discovery is deliberately broad
// (find the /students/<id> link the app itself renders) because the parent-side
// deep link differs per account; run tools/capture-brightwheel.mjs once signed
// in to lock the real shapes.
// ===========================================================================

const log = createLogger("brightwheel");

// Landing on any of these means we are NOT signed in (or got bounced to a
// challenge) — report that rather than parsing a login page as "Fox's day".
const SIGNIN_RE = /\/(sign-in|sign_in|sign-up|forgot-password|password\/new)\b/i;
// Post-password interstitials that a stored credential can't clear on its own.
const CHALLENGE_RE = /(verification code|verify your (identity|device)|two-factor|check your email for a code|enter the code)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- pure helpers (unit-tested) --------------------------------------------

/** True when a URL is a Brightwheel auth wall rather than app content. */
export function isSignInWall(url) {
  return SIGNIN_RE.test(String(url || ""));
}

/** True when the page is asking for an emailed/SMS device code we can't supply. */
export function isDeviceChallenge(text) {
  return CHALLENGE_RE.test(String(text || ""));
}

/**
 * Pick the student the feed lives under from the anchors the app rendered.
 * Prefers a link whose text matches BRIGHTWHEEL.childName (families with more
 * than one enrolled kid), else the first /students/<id> link.
 * @param {{href:string,text?:string}[]} anchors
 * @returns {{id:string, href:string, name:string}|null}
 */
export function pickStudent(anchors = [], childName = BRIGHTWHEEL.childName) {
  const students = [];
  for (const a of anchors) {
    const m = String(a?.href || "").match(/\/students\/([0-9a-f-]{6,})/i);
    if (m) students.push({ id: m[1], href: a.href, name: String(a.text || "").trim() });
  }
  if (!students.length) return null;
  const want = String(childName || "").trim().toLowerCase();
  if (want) {
    const hit = students.find((s) => s.name.toLowerCase().includes(want));
    if (hit) return hit;
  }
  return students[0];
}

// Feed card kinds. Order matters: the more specific patterns win, so an
// "incident report" never lands in the generic note bucket.
const KINDS = [
  ["incident", /\b(incident|injur(y|ed)|bump|bit(e|ten)|accident|first aid|head)\b/i],
  ["message", /\b(message|from (ms\.|mr\.|teacher)|sent you|replied)\b/i],
  ["announcement", /\b(announcement|reminder|newsletter|closed|closure|holiday|picture day|field trip|spirit (day|week)|please (bring|send|pack|label))\b/i],
  ["meal", /\b(meal|breakfast|lunch|snack|bottle|ate|food|menu)\b/i],
  ["nap", /\b(nap|slept|sleep|rest time)\b/i],
  ["bathroom", /\b(diaper|potty|bathroom|restroom|wet|bm)\b/i],
  ["checkin", /\b(check(ed)?[ -]?in|signed in|arrived)\b/i],
  ["checkout", /\b(check(ed)?[ -]?out|signed out|picked up|departed)\b/i],
  ["learning", /\b(learning|activity|activities|lesson|curriculum|theme|unit|circle time|art|craft|paint|sensory|music|story|outdoor|water|science|math|letter of the week)\b/i],
  ["photo", /\b(photo|picture|video|added \d+ photos?)\b/i],
];

/** Classify a feed line/card. Falls back to "note" — never drops content. */
export function classifyKind(text) {
  const t = String(text || "");
  for (const [kind, re] of KINDS) if (re.test(t)) return kind;
  return "note";
}

// Kinds a parent actually needs pushed at them. Photos and diaper logs are
// digest-only; an injury or a "bring a swimsuit Thursday" is not.
const NOTABLE = new Set(["incident", "message", "announcement"]);
export const isNotable = (kind) => NOTABLE.has(kind);

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const TIME_RE = /^(\d{1,2}:\d{2}\s*(?:am|pm)?)\s*/i;

/**
 * Resolve a Brightwheel date header to YYYY-MM-DD. Handles "Today",
 * "Yesterday", "Friday, August 22", "Aug 22, 2026" and "8/22/2026".
 * Returns null when the line isn't a date header at all.
 */
export function parseDateHeader(line, today = new Date(), tz = BRIGHTWHEEL.tz) {
  const s = String(line || "").trim();
  if (!s || s.length > 40) return null;
  const { date } = localParts(today, tz);
  if (/^today\b/i.test(s)) return date;
  if (/^yesterday\b/i.test(s)) {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  const thisYear = Number(date.slice(0, 4));
  const slash = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    const [, mo, d, y] = slash;
    const year = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : thisYear;
    return `${year}-${String(Number(mo)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
  }
  const named = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/);
  if (named) {
    const mi = MONTHS.indexOf(named[1].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      const year = named[3] ? Number(named[3]) : thisYear;
      return `${year}-${String(mi + 1).padStart(2, "0")}-${String(Number(named[2])).padStart(2, "0")}`;
    }
  }
  return null;
}

/** Stable identity for a feed entry, so the same card isn't re-reported daily. */
export function entryKey(e) {
  return `${e.date}|${e.time || ""}|${e.kind}|${String(e.text || "").slice(0, 80)}`;
}

/**
 * Parse the feed's flattened innerText into per-entry rows. Lines that look like
 * date headers set the working day; everything else becomes an entry attributed
 * to that day (falling back to today before the first header, which is how the
 * app renders the top of the feed).
 * @returns {{date:string,time:string,kind:string,text:string}[]}
 */
export function parseFeedText(text, { now = new Date(), tz = BRIGHTWHEEL.tz, maxEntries = BRIGHTWHEEL.maxEntries } = {}) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let day = localParts(now, tz).date;
  const out = [];
  for (const line of lines) {
    const header = parseDateHeader(line, now, tz);
    if (header) {
      day = header;
      continue;
    }
    // Chrome (and Brightwheel) render nav/footer chrome in innerText too; drop
    // the obvious app furniture so it can't become "Fox's activity".
    if (/^(home|feed|messages?|profile|settings|log ?out|sign out|students?|rooms?|help|search)$/i.test(line)) continue;
    if (line.length < 3) continue;
    const tm = line.match(TIME_RE);
    const time = tm ? tm[1].toUpperCase().replace(/\s+/g, " ") : "";
    const body = tm ? line.slice(tm[0].length).trim() : line;
    if (!body) continue;
    out.push({ date: day, time, kind: classifyKind(body), text: body.slice(0, 400) });
    if (out.length >= maxEntries) break;
  }
  return out;
}

const MEAL_SLOTS = [
  ["breakfast", /\bbreakfast\b/i],
  ["lunch", /\blunch\b/i],
  ["amSnack", /\b(am snack|morning snack)\b/i],
  ["pmSnack", /\b(pm snack|afternoon snack)\b/i],
  ["snack", /\bsnack\b/i],
];

/**
 * Fold a day's entries into the shape fox.js stores. activities gets the
 * learning/photo/note prose (that's what drives the wardrobe hint); meals get
 * slotted; a "Theme:"/"Unit:" mention becomes themeOrUnit. Pure.
 */
export function foldDay(entries = []) {
  const activities = [];
  const meals = {};
  let themeOrUnit = "";
  for (const e of entries) {
    const t = e.text;
    const theme = t.match(/\b(?:theme|unit|this week(?:'s)? theme)\s*[:\-–]\s*(.{2,60})/i);
    if (theme && !themeOrUnit) themeOrUnit = theme[1].trim().replace(/[.;]$/, "");
    if (e.kind === "meal") {
      const slot = MEAL_SLOTS.find(([, re]) => re.test(t));
      if (slot) meals[slot[0]] = t.replace(/^\s*(breakfast|lunch|am snack|pm snack|morning snack|afternoon snack|snack)\s*[:\-–]?\s*/i, "").slice(0, 120) || t;
      continue;
    }
    if (e.kind === "learning" || e.kind === "photo" || e.kind === "note" || e.kind === "incident") activities.push(t);
  }
  return {
    activities: [...new Set(activities)].join("; ").slice(0, 900),
    themeOrUnit,
    meals,
  };
}

/** Group entries by date. Pure. */
export function groupByDate(entries = []) {
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  return byDate;
}

/** Compose the owner-facing note for notable new items. Pure. null when none. */
export function composeUpdate(newEntries = []) {
  const notable = newEntries.filter((e) => isNotable(e.kind));
  if (!notable.length) return null;
  const lines = ["From Fox's Brightwheel (Woodbury Preschool):"];
  for (const e of notable.slice(0, 8)) {
    lines.push(`  ${e.date}${e.time ? ` ${e.time}` : ""} [${e.kind}] ${e.text.slice(0, 200)}`);
  }
  if (notable.length > 8) lines.push(`  ...and ${notable.length - 8} more.`);
  return lines.join("\n");
}

// --- persisted state -------------------------------------------------------

const statePath = () => process.env.BRIGHTWHEEL_STATE_PATH || "./data/brightwheel-state.json";

export async function getBrightwheelState() {
  try {
    const j = JSON.parse(await readFile(statePath(), "utf8"));
    return { lastRunDate: j.lastRunDate || null, seen: Array.isArray(j.seen) ? j.seen : [] };
  } catch {
    return { lastRunDate: null, seen: [] };
  }
}

export async function setBrightwheelState({ lastRunDate, seen }) {
  await mkdir(dirname(statePath()), { recursive: true });
  // Cap the seen ring so the file can't grow without bound.
  const capped = (seen || []).slice(-BRIGHTWHEEL.maxSeen);
  await writeFile(statePath(), JSON.stringify({ lastRunDate, seen: capped }, null, 2));
}

/** Run now? Daily, in the configured local window, once per day. Pure. */
export function shouldRunBrightwheel(now, lastRunDate, cfg = BRIGHTWHEEL) {
  const { hour = 5, windowHours = 3, tz = "America/Los_Angeles" } = cfg;
  const { date, hour: h } = localParts(now, tz);
  return { run: h >= hour && h < hour + windowHours && lastRunDate !== date, date };
}

// --- the crawl -------------------------------------------------------------

/** Anchors as {href,text}, absolute. Runs in the page. */
/* istanbul ignore next -- browser context, not covered by node --test */
function anchorsInPage() {
  return Array.from(document.querySelectorAll("a[href]"))
    .slice(0, 400)
    .map((a) => ({ href: a.href, text: (a.innerText || a.textContent || "").trim().slice(0, 60) }));
}

/**
 * Answer a sign-in wall using credentials the FAMILY provisioned in .env. Returns
 * {signedIn, reason}. Never logs or returns the password. No-ops (and says so)
 * when no credential is configured — the session path is the intended default.
 */
async function signInIfWalled(page) {
  if (!isSignInWall(page.url())) return { signedIn: true, via: "session" };
  const { username, password } = BRIGHTWHEEL;
  if (!username || !password) {
    return { signedIn: false, reason: "not signed in on this Chrome profile, and no stored credential configured" };
  }
  log.info("brightwheel sign-in wall; using stored credential");
  await page.fill('input[type="text"], input[name*="user" i], input[type="email"]', username);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: BRIGHTWHEEL.timeoutMs }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await sleep(BRIGHTWHEEL.settleMs);
  const body = await page.innerText("body").catch(() => "");
  if (isDeviceChallenge(body)) {
    return { signedIn: false, reason: "Brightwheel asked for an emailed device code — sign in once by hand in this Chrome profile" };
  }
  if (isSignInWall(page.url())) return { signedIn: false, reason: "credential was rejected (or the form changed)" };
  return { signedIn: true, via: "password" };
}

/**
 * Crawl Fox's Brightwheel feed. Read-only.
 * @returns {{signedIn:boolean, reason?:string, student?:object, entries:object[], url?:string}}
 */
export async function fetchBrightwheelFeed({ open } = {}) {
  const home = BRIGHTWHEEL.homeUrl;
  await assertPublicUrl(home);
  const runner = open || (BRIGHTWHEEL.headed ? withHeadedPage : withPage);
  return runner(async (page) => {
    await page.goto(home, { waitUntil: "domcontentloaded", timeout: BRIGHTWHEEL.timeoutMs });
    await sleep(BRIGHTWHEEL.settleMs); // the app is an SPA; let the feed paint

    const auth = await signInIfWalled(page);
    if (!auth.signedIn) {
      log.info("brightwheel skipped", { reason: auth.reason });
      return { signedIn: false, reason: auth.reason, entries: [] };
    }

    // Follow the student link the app itself rendered rather than guessing at a
    // parent-side deep path. If there isn't one, the landing page IS the feed
    // for single-child parent accounts — read that.
    const anchors = await page.evaluate(anchorsInPage).catch(() => []);
    const student = pickStudent(anchors);
    if (student) {
      try {
        await assertPublicUrl(student.href);
        await page.goto(student.href, { waitUntil: "domcontentloaded", timeout: BRIGHTWHEEL.timeoutMs });
        await sleep(BRIGHTWHEEL.settleMs);
      } catch (e) {
        log.warn("student page navigation failed; using landing page", { reason: e.message });
      }
    }
    if (isSignInWall(page.url())) {
      return { signedIn: false, reason: "session dropped mid-crawl", entries: [] };
    }

    const text = await page.innerText("body").catch(() => "");
    const entries = parseFeedText(text);
    log.info("brightwheel feed read", { via: auth.via, entries: entries.length, student: student?.id || null });
    return { signedIn: true, student, entries, url: page.url() };
  });
}

/**
 * Pull the feed, store each day into foxDailyContext (so the morning digest
 * renders it with no digest change), and push ONLY notable new items at the
 * owner. Quiet by design: no nag when the profile isn't signed in, nothing sent
 * when the only new items are photos and diaper logs.
 * @returns {{signedIn, days:number, newEntries:number, notified:boolean, reason?:string}}
 */
export async function runBrightwheelPull({ fetch = fetchBrightwheelFeed, save = setFoxDay, notify = notifyOwner, firstRun } = {}) {
  const res = await fetch();
  if (!res || !res.signedIn) return { signedIn: false, reason: res?.reason, days: 0, newEntries: 0, notified: false };

  const state = await getBrightwheelState();
  const seen = new Set(state.seen);
  const fresh = res.entries.filter((e) => !seen.has(entryKey(e)));

  let days = 0;
  for (const [date, entries] of groupByDate(res.entries)) {
    const folded = foldDay(entries);
    if (!folded.activities && !Object.keys(folded.meals).length && !folded.themeOrUnit) continue;
    try {
      await save(date, folded); // setFoxDay merges non-clobbering + derives the wardrobe hint
      days++;
    } catch (e) {
      log.error("fox day save failed", { date, reason: e.message });
    }
  }

  // FIRST run has an empty seen-set, so every card in the feed reads as "new".
  // Seed the set silently instead of blasting weeks of backlog at the family;
  // the days are still saved above, so the digest gets the history either way.
  // The caller passes this when it already claimed lastRunDate (the heartbeat
  // does, so a restart mid-crawl can't double-run the browser).
  const isFirst = firstRun ?? (!state.lastRunDate && !state.seen.length);
  let notified = false;
  const update = isFirst ? null : composeUpdate(fresh);
  if (update && BRIGHTWHEEL.notify) {
    await notify(update);
    notified = true;
  }

  await setBrightwheelState({
    lastRunDate: localParts(new Date(), BRIGHTWHEEL.tz).date,
    seen: [...state.seen, ...fresh.map(entryKey)],
  });
  log.info("brightwheel pull done", { days, newEntries: fresh.length, notified });
  return { signedIn: true, days, newEntries: fresh.length, notified };
}
