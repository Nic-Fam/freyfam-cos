import { MODELS, DIGEST } from "./config.js";
import { runChief } from "./orchestrator.js";
import { notifyOwner } from "./channels/twilio.js";
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

const DIGEST_PROMPT = `It is morning. Compose a brief MORNING DIGEST for the family, then output ONLY the digest text (it is sent as a message, so no preamble).

Gather what you need first:
- Today's schedule: call list_calendar with days 1 (it merges Nic's and Shelli's
  calendars; each event names whose calendar it is on). Note who has what today.
- Fox's day at Bright Horizons: call fox_today. Include his activities and the
  WARDROBE note so they can dress him right (old clothes on paint/messy days, a
  full change of clothes on water days).
- Commute + weather: the house rules list home plus each person's destination
  and that Shelli keeps her own schedule. For each route (home to Nic's work,
  home to Shelli's work, home to Fox's Glendale drop-off) call commute_time for
  the precise ETA and any traffic delay, and use web_search for today's weather
  at each destination. Give a one-line per-person heads-up. Skip anyone who is
  not heading out today.
- Meals planned + anything expiring in the kitchen: delegate to chef (Carmine).
- Anything money-related worth a heads-up: delegate to finance (Patrick).
- Any security flags: delegate to security (Frank).
- Notable resale finds worth a glance: delegate to resale (Shey).

Then write it warm, short, and scannable: a one-line greeting, today's schedule,
the per-person commute + weather lines, Fox's day + wardrobe note, meals plus any
prep reminder, and any flags. Skip sections that have nothing. Plain punctuation,
no em dashes.`;

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
export async function runMorningDigest({ runner = runChief, notify = notifyOwner, mail = sendMail } = {}) {
  const text = await runner(DIGEST_PROMPT, MODELS.standard, { webSearch: true });
  const body = text && text.trim();
  if (!body) {
    log.warn("digest produced no text; nothing sent");
    return text;
  }
  const sends = [notify(body)];
  if (DIGEST.emailTo.length) sends.push(mail({ to: DIGEST.emailTo, subject: digestSubject(), body }));
  const results = await Promise.allSettled(sends);
  results.forEach((r, i) => {
    if (r.status === "rejected") log.error("digest delivery failed", { channel: i === 0 ? "sms" : "email", reason: String(r.reason?.message || r.reason) });
  });
  return text;
}
