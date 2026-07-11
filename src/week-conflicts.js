// Weekly week-ahead scheduling-conflict scan. Flags SAME-person double-bookings
// (two overlapping timed events on the same calendar owner) in the next 7 days, so
// the family gets lead time to reschedule instead of discovering the clash the
// morning of (tracker item 004). Read-only + owner notification (NOT the
// confirmation gate: this informs, it does not act on the family's behalf). Runs on
// a weekly cadence off the heartbeat, once per day, persisted so a restart in the
// window can't re-fire it. Composition is deterministic (no model spend).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { listEvents } from "./channels/graph.js";
import { notifyOwner } from "./channels/notify.js";
import { localParts } from "./digest.js";
import { createLogger } from "./log.js";

const log = createLogger("week-conflicts");

export const WEEK_CONFLICTS = {
  enabled: String(process.env.WEEK_CONFLICTS_ENABLED ?? "true").toLowerCase() === "true",
  weekday: Number(process.env.WEEK_CONFLICTS_WEEKDAY ?? 0), // 0 = Sunday
  hour: Number(process.env.WEEK_CONFLICTS_HOUR ?? 17), // 5pm local, before the Sun-night finance report
  windowHours: 3,
  tz: process.env.WEEK_CONFLICTS_TZ || "America/Los_Angeles",
  days: 7,
  minOverlapMs: 15 * 60 * 1000, // ignore <15min touches (adjacent events that graze)
};

// Parse an event's [startMs, endMs]; null for all-day or unparseable/zero-length.
function interval(e) {
  const s = Date.parse(e.start), en = Date.parse(e.end);
  if (!Number.isFinite(s) || !Number.isFinite(en) || en <= s) return null;
  // All-day: starts at local midnight and spans >= ~24h. These "overlap" everything
  // that day and aren't a double-booking, so exclude them from conflict detection.
  if (/T00:00(:00)?/.test(String(e.start)) && en - s >= 23 * 3600 * 1000) return null;
  return [s, en];
}

/**
 * Pure: same-person overlapping timed events -> conflicts. Cross-person overlaps
 * (Nic busy while Shelli is busy) are intentionally NOT flagged -- two working
 * parents overlap most of every day, so that would be pure noise; a genuine
 * "one person, two places at once" is the actionable signal.
 */
export function findConflicts(events, { minOverlapMs = WEEK_CONFLICTS.minOverlapMs } = {}) {
  const items = [];
  for (const e of events || []) {
    if (e.showAs === "free") continue; // a "free" block isn't a commitment
    const iv = interval(e);
    if (iv) items.push({ e, s: iv[0], en: iv[1] });
  }
  items.sort((a, b) => a.s - b.s);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[j].s >= items[i].en) break; // sorted by start: nothing later overlaps i
      const overlap = Math.min(items[i].en, items[j].en) - items[j].s;
      if (overlap < minOverlapMs) continue;
      const who = (items[i].e.calendars || []).filter((p) => (items[j].e.calendars || []).includes(p));
      if (who.length) out.push({ person: who.join(" & "), a: items[i].e, b: items[j].e });
    }
  }
  return out;
}

function fmtWhen(iso, tz) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(t);
}

/** Pure: deterministic owner message, or null when there's nothing to flag. */
export function formatConflicts(conflicts, { tz = WEEK_CONFLICTS.tz } = {}) {
  if (!conflicts || !conflicts.length) return null;
  const lines = conflicts.map((c) => {
    const who = c.person.charAt(0).toUpperCase() + c.person.slice(1);
    return `- ${who}: "${c.a.subject}" (${fmtWhen(c.a.start, tz)}) overlaps "${c.b.subject}" (${fmtWhen(c.b.start, tz)})`;
  });
  const n = conflicts.length;
  return `Week ahead: ${n} scheduling ${n === 1 ? "conflict" : "conflicts"} to sort out before ${n === 1 ? "it lands" : "they land"}:\n${lines.join("\n")}`;
}

/** Sunday evening window, once per day (same shape as the weekly finance report). */
export function shouldRunWeekConflicts(now, lastRunDate, cfg = WEEK_CONFLICTS) {
  const { date, hour } = localParts(now, cfg.tz);
  const onDay = new Date(`${date}T12:00:00Z`).getUTCDay() === cfg.weekday;
  const inWindow = hour >= cfg.hour && hour < cfg.hour + cfg.windowHours;
  return { run: onDay && inWindow && lastRunDate !== date, date };
}

const statePath = () => process.env.WEEK_CONFLICTS_STATE_PATH || "./data/week-conflicts-state.json";
export async function getLastConflictRun() {
  try { return JSON.parse(await readFile(statePath(), "utf8")).lastRunDate || null; } catch { return null; }
}
export async function setLastConflictRun(date) {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify({ lastRunDate: date }, null, 2));
}

/** Fetch the week ahead, find conflicts, notify the owner. Silent when clear. */
export async function runWeekAheadConflicts({ list = listEvents, notify = notifyOwner, cfg = WEEK_CONFLICTS } = {}) {
  const events = await list({ days: cfg.days });
  const conflicts = findConflicts(events, { minOverlapMs: cfg.minOverlapMs });
  const msg = formatConflicts(conflicts, { tz: cfg.tz });
  if (msg) {
    await notify(msg);
    log.info("week-ahead conflicts sent", { count: conflicts.length });
  } else {
    log.info("week-ahead conflicts: none", {});
  }
  return conflicts.length;
}
