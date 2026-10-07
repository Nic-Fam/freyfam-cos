import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MODELS, DIGEST } from "./config.js";
import { dayPlan } from "./schedule.js";
import { summary as downsizingSummary } from "./downsizing.js";
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

/**
 * Weather + travel. Two rules drive this:
 *   - HOME weather goes in every single day, regardless of who is going anywhere.
 *   - Travel follows TODAY'S SCHEDULE FIRST. A real commitment (doctor, Gary's, a
 *     tour) is the destination; the work commute is only a FALLBACK for a person
 *     with nothing else on the calendar, and only on a day they'd be in-office.
 * The plan supplies the fallback rules (who is in-office, whether daycare runs);
 * the actual destinations come from the calendar at compose time. Pure.
 */
export function commuteSection(plan) {
  const legFor = (p) =>
    p.chainedDaycare && plan.daycare
      ? `    - ${p.name}: his drive is CHAINED through daycare. Route home -> Woodbury
      Preschool (Altadena) to drop Fox off, then Woodbury -> wherever he is headed
      (appointment or work), and give the TOTAL morning drive, not a single leg.`
      : `    - ${p.name}: route home -> wherever ${p.name} is headed.`;

  const fallback = plan.out.length
    ? `Only if a person has NO away-from-home commitment on the calendar, fall back to
  their work commute:
${plan.out.map((p) => (p.chainedDaycare && plan.daycare
      ? `    - ${p.name}: home -> Woodbury Preschool (Altadena) -> ${p.name}'s work, TOTAL drive.`
      : `    - ${p.name}: home -> ${p.name}'s work.`)).join("\n")}`
    : `There is NO work-commute fallback today${plan.isWeekend ? " (weekend)" : ""}: nobody is
  due in an office, so route ONLY to what the calendar actually shows. Never invent a
  work commute, and never include work-location weather.`;

  const homeNote = plan.home.length
    ? `\n  ${plan.home.map((p) => `${p.name} (${p.reason})`).join(" and ")} ${plan.home.length > 1 ? "have" : "has"} no work
  commute today: route ${plan.home.length > 1 ? "them" : "them"} only if the calendar puts ${plan.home.length > 1 ? "them" : "them"} somewhere.`
    : "";

  const daycareNote = plan.daycare ? "" : `\n  Daycare is closed today, so never include a drop-off leg.`;

  // Weather is listed SEPARATELY from routing on purpose. Tying it to "wherever a
  // person is headed" silently dropped Woodbury: Fox is there all day even though
  // nobody's trip ENDS there, and it is the forecast they dress him for.
  const weatherStops = [
    `    - HOME, every single day, whether or not anyone leaves the house.`,
    plan.daycare
      ? `    - Woodbury Preschool (Altadena), because Fox is there all day. Include it
      whenever daycare runs, even though it is only a drop-off stop on the way to
      somewhere else: it is the forecast they dress Fox for.`
      : null,
    `    - every place someone actually travels to below (an appointment location, or
      their workplace). Do not skip the workplace just because it is the fallback.`,
  ].filter(Boolean);

  return `- Weather + travel:
  WEATHER: call get_weather for EACH of these and give a short line each:
${weatherStops.join("\n")}
  TRAVEL is driven by TODAY'S SCHEDULE FIRST, not by a default commute:
    1. For each person, find their FIRST commitment today that is away from home
       (a doctor's appointment, Gary's, a tour, anything with a location). If there
       is one, that is their destination: call commute_time from home to THAT place.
       This OUTRANKS any work commute.
${plan.out.map(legFor).join("\n") || "    - (nobody is in-office today)"}
    2. ${fallback}
    3. A person with neither gets no travel line at all.
  One short line per person who is actually going somewhere.${homeNote}${daycareNote}`;
}

/** The move-sale line, only when items are still live. Pure. */
export function moveSaleSection(move) {
  if (!move) return null;
  return `- Move sale: ${move.active} listed and ${move.draft} still in draft (${move.sold} sold).
  One short line nudging the remaining drafts to get posted. Do not recap items
  already sold or pulled.`;
}

/**
 * Gather the day's shape before composing: who travels, whether daycare runs, and
 * whether the move sale still has anything live. Doing this in CODE (not in the
 * prompt) is what stops the digest asking for sections that cannot apply today.
 */
export async function buildDigestContext(now = new Date(), { tz = DIGEST.tz, moveSummary = downsizingSummary } = {}) {
  const plan = dayPlan(now, tz);
  let move = null;
  if (DIGEST.moveSale) {
    try {
      const s = await moveSummary();
      // Only surface it while something is still live. Once everything is sold or
      // pulled the section disappears for good instead of reporting "done" daily.
      if ((s?.draft || 0) + (s?.active || 0) > 0) move = s;
    } catch {
      /* a store hiccup must never block the digest */
    }
  }
  return { plan, move };
}

// The prompt is built per-run so TODAY's date is injected as ground truth. The
// model was unreliable at computing the date itself (it once wrote "June 22 /
// Monday" on Sunday the 21st and then dropped that day's events as "past"), so we
// hand it the authoritative weekday + ISO key and tell it to anchor on them.
// `ctx` (see buildDigestContext) decides which sections are even requested.
export function buildDigestPrompt(now = new Date(), tz = DIGEST.tz, ctx = null) {
  const human = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric",
  }).format(now);
  const { date } = localParts(now, tz); // YYYY-MM-DD
  const { plan, move } = ctx || { plan: dayPlan(now, tz), move: null };

  // Only ask for the sections that can actually apply today. Anything that cannot
  // (a commute on a weekend, Fox's day when daycare is closed, a finished move
  // sale) is omitted from the brief entirely rather than asked-for-then-skipped.
  const sections = [
    `- Today's schedule: call list_calendar with days 1 (it merges Nic's and Shelli's
  calendars; each event names whose calendar it is on). Anything dated ${date} is
  today. List EVERY non-work event for today with its time and whose it is; do not
  omit or merge them away (an all-day event does not cover timed ones). For WORK
  events, though, include ONLY the single earliest one of the day (per person) so
  we know when the day starts; do not list the rest of that person's work events.
  Treat an event as a work event if it is on a work calendar or has an attendee at
  a work domain (flyerdefense.com for Nic, disney.com for Shelli).`,
    plan.daycare
      ? `- Fox's day at Woodbury Preschool: call fox_today. Include his activities and the
  WARDROBE note so they can dress him right (old clothes on paint/messy days, a
  full change of clothes on water days).`
      : null,
    `- Dinner out: check today's schedule for an event in the DINNER window (~4:30-8:30 PM)
  at a location AWAY from home (the family lives in the La Crescenta area; a tour,
  appointment, or plans in another neighborhood around that time counts).
  FIRST WORK OUT WHO IS ACTUALLY THERE. list_calendar merges both calendars and
  names whose each event is on, and the same event often appears on BOTH Nic's and
  Shelli's calendars (and the attendee list says who else is invited). Check both
  before deciding, and say who the suggestion is for:
    - Both Nic and Shelli at it: suggest dinner for the two of them (note that Fox
      would need to be covered if it runs past his bedtime routine).
    - Only ONE of them out: do NOT pitch a dinner out. One person at an evening
      appointment is not a family dinner plan. Mention it only if they would
      plausibly want to grab something solo on the way home, in one short line.
  When a dinner out does make sense, suggest 2-3 well-reviewed spots near that
  location: use \`search\` (e.g. "best dinner restaurants near <place>") to find them,
  name each with a one-line why, and offer to check a table (find_reservation) or
  book (make_reservation). Keep it to a few lines. Skip entirely if the evening is
  free, plans are at home, or nothing is near dinnertime -- don't force it.`,
    moveSaleSection(move),
    commuteSection(plan),
    `- Follow-ups and open actions: first call list_calendar with days 1 AND back 1, so
  you also see what happened YESTERDAY. For any notable event that just passed and
  genuinely needs a next step, check list_tasks; if no open follow-up exists for it
  yet, create one with add_task, phrased as the ACTION and dated ${date} (e.g.
  add_task title "Follow up: email Deborah re: Fairview tour" dueDate ${date}).
  BE STRICT ABOUT WHAT EARNS A FOLLOW-UP. Only create one when ALL of these hold:
    1. it involves someone OUTSIDE the household, or leaves a decision/deliverable
       still open (a tour to respond to, a quote to chase, a form to send back), AND
    2. something would actually go wrong if it were forgotten.
  Never create a follow-up for a routine or self-completing thing. Chores, reminders,
  household tasks, personal routines and recurring events COMPLETE BY HAPPENING: once
  the dogs are out in the garden, the trash is at the curb, or a workout is done,
  there is nothing to follow up on and nothing to report. Do not ask how any of them
  went, and do not add them to the list.
  Then call list_tasks and surface EVERY open follow-up plus anything overdue or due
  today AS A NUMBERED LIST (1., 2., 3. ...), keeping the SAME order and numbers
  list_tasks returns so a later "done 2" maps to the right one. The numbers make it
  easy to see at a glance which items are done or still need input. Close the section
  with exactly: "To clear any of these, reply 'done 2' with its number (or 'done <the
  item>'), and I'll mark it handled." If there are no open follow-ups at all, omit
  this whole section including that closing line.
  GROUNDING (important): never state that a task, hunt, tour, or action is "over",
  "done", "completed", or "wrapped up" unless list_tasks shows it done or the
  family told you. If you are not sure, treat it as still OPEN. Do not invent
  completion.`,
    `- Package deliveries expected today: call list_packages and include anything arriving
  today or in transit (what it is + carrier + ETA/status). A short "Arriving:" line;
  skip it entirely if nothing is on the way.`,
    `- Meals planned + anything expiring in the kitchen: delegate to chef (Carmine).`,
    `- Recent vendor/food receipts: call list_receipts. If any, fold the notable totals
  into the finance heads-up (spend) and flag grocery receipts in the kitchen note as
  food coming in. Skip the whole thing if there are none.`,
    `- Anything money-related worth a heads-up: delegate to finance (Patrick). (Spend
  trends live in the separate weekly finance report, so keep this to anything
  time-sensitive: a bill due, an unusual charge worth flagging today.) Any finance
  flag MUST be grounded in a real logged transaction (actual merchant + amount +
  date); never invent amounts, totals, or "unnamed withdrawals". If nothing real is
  worth flagging, omit the finance section entirely.`,
    `- Any security flags: delegate to security (Frank).`,
    `- Notable resale finds worth a glance: delegate to resale (Shey). Her saved-search
  "traces" are ONGOING hunts, never one-and-done: report any NEW results as the
  action ("Dsquared trace: 2 new matches, take a look"), and never say a trace is
  "over" or "done" -- a hunt with no new results today is simply quiet, still running.`,
  ].filter(Boolean);

  return `Today is ${human} (${date}). It is morning. Anchor EVERYTHING to this date: do not compute or state any other date, and treat a calendar event dated ${date} as TODAY (events on other dates are not today; mention them only in a brief "coming up" note if useful).

Compose a brief MORNING DIGEST for the family.

Gather what you need first:
${sections.join("\n")}

Then write it warm, short, and scannable: a one-line greeting that names ${human},
then only the parts that have something to say today.

WRITE WHAT MATTERS, OMIT THE REST. This is the most important rule:
- If a section has nothing to report, leave it out COMPLETELY: no heading, no
  "nothing today", no "all clear", no "no new matches", no empty bullet.
- Never report that something is already finished, handled, or no longer running.
  A finished thing is simply absent from the digest, not announced again.
- Do not narrate what you skipped or why. The family should see only live items.
- Vary the shape to the day. A quiet day should be a few short lines; do not pad
  it out to look like a full template.
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
export function shouldRunDigest(now, lastRunDate, { hour = 6, tz = "America/Los_Angeles", windowHours = 2 } = {}) {
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
export async function runMorningDigest({ runner = runChief, notify = postSlack, mail = sendMail, now = new Date() } = {}) {
  // Weather now comes from the free get_weather tool, so the digest no longer
  // needs the metered web_search tool. DIGEST.webSearch stays as an opt-in
  // escape hatch (default off) for any other live lookup the chief might want.
  // The context decides which sections are requested at all (see buildDigestContext).
  const ctx = await buildDigestContext(now);
  const text = await runner(buildDigestPrompt(now, DIGEST.tz, ctx), MODELS.standard, { webSearch: DIGEST.webSearch });
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
