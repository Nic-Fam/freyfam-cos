import { MODELS, DIGEST } from "./config.js";
import { runChief } from "./orchestrator.js";
import { notifyOwner } from "./channels/twilio.js";
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
- Today's schedule: call list_calendar.
- Meals planned + anything expiring in the kitchen: delegate to chef (Carmine).
- Anything money-related worth a heads-up: delegate to finance (Patrick).
- Any security flags: delegate to security (Frank).
- Notable resale finds worth a glance: delegate to resale (Shey).

Then write it warm, short, and scannable for a text message: a one-line greeting, today's schedule, meals plus any prep reminder, and any flags. Skip sections that have nothing. Plain punctuation, no em dashes.`;

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

/** Compose (via Lloyd delegating to specialists) and deliver the digest. */
export async function runMorningDigest({ runner = runChief, notify = notifyOwner } = {}) {
  const text = await runner(DIGEST_PROMPT, MODELS.standard);
  if (text && text.trim()) await notify(text.trim());
  else log.warn("digest produced no text; nothing sent");
  return text;
}
