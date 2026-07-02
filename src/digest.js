import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MODELS, DIGEST } from "./config.js";
import { runChief } from "./orchestrator.js";
import { postSlack } from "./channels/notify.js";
import { sendMail } from "./channels/graph.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Morning digest — ported from the legacy assistant's daily timer. Under the
// specialist split, Lloyd no longer reads every domain himself; he COMPOSES the
// digest by delegating to the specialists (he already has the delegate +
// list_calendar tools). The agent loop does the gathering; we just give it the
// brief and deliver the result.
//
// Fires once per LOCAL day inside a morning window (so a daemon restart at 3pm
// doesn't send a stale "morning" digest). Scheduling lives in heartbeat.js.
// ===========================================================================

const log = createLogger("digest");

// The prompt is built per-run so TODAY's date is injected as ground truth. The
// model was unreliable at computing the date itself (it once wrote "June 22 /
// Monday" on Sunday the 21st and then dropped that day's events as "past"), so we
// hand it the authoritative weekday + ISO key and tell it to anchor on them.
export function buildDigestPrompt(now = new Date(), tz = DIGEST.tz) {
  const human = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(now);
  const { date } = localParts(now, tz); // YYYY-MM-DD
  // Weather comes from get_weather (free NWS, no metered web_search) at the same
  // destinations as the commute, so the two share one bullet.
  const commuteLine =
    `- Commute + weather: the house rules list home plus each person's destination
  and that Shelli keeps her own schedule. For each route (home to Nic's work,
  home to Shelli's work, home to Fox's Glendale drop-off) call commute_time for
  the precise ETA and any traffic delay, and call get_weather for that
  destination's weather today. Give a one-line per-person heads-up. Skip anyone
  who is not heading out today (e.g. on a weekend, skip work commutes).`;
  return `Today is ${human} (${date}). It is morning. Anchor EVERYTHING to this date: do not compute or state any other date, and treat a calendar event dated ${date} as TODAY (events on other dates are not today; mention them only in a brief "coming up" note if useful).

Compose a brief MORNING DIGEST for the family.

Gather what you need first:
- Today's schedule: call list_calendar with days 1 (it merges Nic's and Shelli's
  calendars; each event names whose calendar it is on). Anything dated ${date} is
  today. List EVERY non-work event for today with its time and whose it is; do not
  omit or merge them away (an all-day event does not cover timed ones). For WORK
  events, though, include ONLY the single earliest one of the day (per person) so
  we know when the day starts; do not list the rest of that person's work events.
  Treat an event as a work event if it is on a work calendar or has an attendee at
  a work domain (flyerdefense.com for Nic, disney.com for Shelli).
- Fox's day at Bright Horizons: call fox_today. Include his activities and the
  WARDROBE note so they can dress him right (old clothes on paint/messy days, a
  full change of clothes on water days).
${commuteLine}
- Follow-ups and open actions: first call list_calendar with days 1 AND back 1, so
  you also see what happened YESTERDAY. For any notable event that just passed and
  needs a next step (a house tour, a meeting with a named outside person, an
  appointment with an action afterward), check list_tasks; if no open follow-up
  exists for it yet, create one with add_task, phrased as the ACTION and dated
  ${date} (e.g. add_task title "Follow up: email Deborah re: Fairview tour"
  dueDate ${date}). Then call list_tasks and surface EVERY open follow-up plus
  anything overdue or due today. Close the section with exactly: "To clear any of
  these, reply 'done <item>' and I'll mark it handled."
  GROUNDING (important): never state that a task, hunt, tour, or action is "over",
  "done", "completed", or "wrapped up" unless list_tasks shows it done or the
  family told you. If you are not sure, treat it as still OPEN. Do not invent
  completion.
- Package deliveries expected today: call list_packages and include anything arriving
  today or in transit (what it is + carrier + ETA/status). A short "Arriving:" line;
  skip it entirely if nothing is on the way.
- Meals planned + anything expiring in the kitchen: delegate to chef (Carmine).
- Anything money-related worth a heads-up: delegate to finance (Patrick). (Spend
  trends live in the separate weekly finance report, so keep this to anything
  time-sensitive: a bill due, an unusual charge worth flagging today.) Any finance
  flag MUST be grounded in a real logged transaction (actual merchant + amount +
  date); never invent amounts, totals, or "unnamed withdrawals". If nothing real is
  worth flagging, omit the finance section entirely.
- Any security flags: delegate to security (Frank).
- Notable resale finds worth a glance: delegate to resale (Shey). Her saved-search
  "traces" are ONGOING hunts, never one-and-done: report any NEW results as the
  action ("Dsquared trace: 2 new matches, take a look"), and never say a trace is
  "over" or "done" -- a hunt with no new results today is simply quiet, still running.

Then write it warm, short, and scannable: a one-line greeting that names ${human},
today's schedule, the per-person commute + weather lines, Fox's day + wardrobe
note, the follow-ups & open actions (with the "reply 'done <item>'" clear line),
any package deliveries expected today, meals plus any prep reminder, and any flags.
Skip sections that have nothing.
Plain punctuation, no em dashes.

Output ONLY the finished digest, wrapped exactly in <digest> and </digest> tags,
with NOTHING before or after the tags (no preamble, no notes to yourself).`;
}

// Pull the digest out of the fenced tags so any stray model preamble/reasoning
// before <digest> never reaches the family. Falls back to the raw text if the
// model omitted the tags.
export function extractDigest(text) {
  const m = String(text || "").match(/<digest>([\s\S]*?)<\/digest>/i);
  return (m ? m[1] : String(text || "")).trim();
}

// Local {date:"YYYY-MM-DD", hour:0-23} for a tz, without relying on UTC.
export function localParts(now, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hour12: false,
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
}

/**
 * Should the digest run now? True only inside [hour, hour+windowHours) local AND
 * not already sent today. Returns the local date so the caller can record it.
 * Pure + exported for tests.
 */
export function shouldRunDigest(now, lastRunDate, { hour = 7, tz = "America/Los_Angeles", windowHours = 2 } = {}) {
  const { date, hour: h } = localParts(now, tz);
  const inWindow = h >= hour && h < hour + windowHours;
  return { run: inWindow && lastRunDate !== date, date };
}

// Persisted "last digest date" so the once-per-day guard survives a daemon
// restart. It was in-memory, so a restart inside the morning catch-up window
// reset it to null and the digest fired again (it sent 3x on 6/21 across
// restarts). The file is the source of truth across process lifetimes.
const statePath = () => process.env.DIGEST_STATE_PATH || "./data/digest-state.json";

async function readState() {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8"));
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}
async function writeState(state) {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(state, null, 2));
}

export async function getLastDigestDate() {
  return (await readState()).lastRunDate || null;
}
export async function setLastDigestDate(date) {
  const s = await readState();
  s.lastRunDate = date;
  await writeState(s);
}
// Separate "already alerted the owner about a failed digest today" marker, so a
// retrying-but-failing digest pings the owner ONCE per day, not every tick.
export async function getDigestAlertedDate() {
  return (await readState()).alertedDate || null;
}
export async function setDigestAlertedDate(date) {
  const s = await readState();
  s.alertedDate = date;
  await writeState(s);
}

/** Subject line for the emailed digest, dated in the family timezone. */
export function digestSubject(now = new Date()) {
  const d = new Intl.DateTimeFormat("en-US", {
    timeZone: DIGEST.tz,
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);
  return `Morning digest: ${d}`;
}

/**
 * Compose (via Lloyd delegating to specialists) and deliver the digest over BOTH
 * channels: SMS to the owner (rides Twilio clearance) and email to the family
 * (reliable today). Each send is independent, so one failing never blocks the
 * other. Channels injectable for tests.
 */
export async function runMorningDigest({ runner = runChief, notify = postSlack, mail = sendMail } = {}) {
  // Weather now comes from the free get_weather tool, so the digest no longer
  // needs the metered web_search tool. DIGEST.webSearch stays as an opt-in
  // escape hatch (default off) for any other live lookup the chief might want.
  const text = await runner(buildDigestPrompt(), MODELS.standard, { webSearch: DIGEST.webSearch });
  const body = extractDigest(text);
  if (!body) {
    log.warn("digest produced no text; nothing sent");
    return { delivered: false, empty: true, body: "" };
  }
  const sends = [notify(body)];
  if (DIGEST.emailTo.length) sends.push(mail({ to: DIGEST.emailTo, subject: digestSubject(), body }));
  const results = await Promise.allSettled(sends);
  results.forEach((r, i) => {
    if (r.status === "rejected") log.error("digest delivery failed", { channel: i === 0 ? "owner" : "email", reason: String(r.reason?.message || r.reason) });
  });
  // notifyOwner returns "sent"/null (never throws); mail throws on failure. Delivered
  // if ANY channel actually went out. `delivered:false` here means composed-but-undeliverable.
  const notifyOk = results[0].status === "fulfilled" && results[0].value !== null;
  const mailOk = sends.length > 1 && results[1].status === "fulfilled";
  const delivered = notifyOk || mailOk;
  if (!delivered) log.error("digest composed but no channel delivered");
  return { delivered, empty: false, body };
}
