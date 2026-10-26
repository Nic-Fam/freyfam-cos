import { SCHEDULE, CALENDAR, FAMILY_PEOPLE } from "./config.js";

// ===========================================================================
// Calendar facts, computed in CODE so Lloyd never has to do date arithmetic.
//
// The recurring calendar failures were all reasoning slips the model shouldn't be
// making in the first place: naming the wrong weekday for a date, booking last
// year, judging "during the workday" by the current time instead of the event's.
// Everything here is pure and works on the WALL-CLOCK date/time in an event ISO
// string ("2026-10-14T14:00:00" = 2:00 PM family time), which is the convention the
// calendar tools use, so results never depend on the server's timezone.
// ===========================================================================

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

/** Wall-clock parts of an ISO date or date-time string; null if unparseable. */
export function wallClock(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const hasTime = m[4] !== undefined;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`, y, mo, d,
    h: hasTime ? +m[4] : 0, mi: hasTime ? +m[5] : 0, hasTime,
    dow: new Date(Date.UTC(y, mo - 1, d)).getUTCDay(),
  };
}

/** Today's date (YYYY-MM-DD) in the family timezone. */
export function todayISO(now = new Date(), tz = SCHEDULE.tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const isoOf = (ms) => {
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};
const fmtTime = (h, mi) => `${h % 12 || 12}:${pad(mi)} ${h >= 12 ? "PM" : "AM"}`;

/** Add minutes to a wall-clock ISO date-time, staying in wall-clock terms. */
export function addMinutes(iso, minutes) {
  const s = wallClock(iso);
  if (!s || !s.hasTime) return iso;
  const dt = new Date(Date.UTC(s.y, s.mo - 1, s.d, s.h, s.mi) + minutes * 60000);
  return `${isoOf(dt.getTime())}T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:00`;
}

/** Human, authoritative description: "Tuesday, Oct 14, 2:00 PM - 3:00 PM". */
export function describeEventTime(start, end) {
  const s = wallClock(start);
  if (!s) return String(start || "");
  const day = `${DAYS[s.dow]}, ${MONTHS[s.mo - 1]} ${s.d}`;
  if (!s.hasTime) return `${day} (all day)`;
  const e = wallClock(end);
  let tail = "";
  if (e && e.hasTime && (e.h !== s.h || e.mi !== s.mi || e.date !== s.date)) {
    tail = e.date === s.date ? ` - ${fmtTime(e.h, e.mi)}` : ` - ${DAYS[e.dow]}, ${MONTHS[e.mo - 1]} ${e.d}, ${fmtTime(e.h, e.mi)}`;
  }
  return `${day}, ${fmtTime(s.h, s.mi)}${tail}`;
}

/** Facts the invitee rules depend on, taken from the EVENT's own date and time. */
export function eventFacts(start, { sched = SCHEDULE, workHours = CALENDAR.workHours } = {}) {
  const s = wallClock(start);
  if (!s) return null;
  const isWorkday = sched.workDays.includes(s.dow);
  const duringWorkHours = isWorkday && s.hasTime && s.h >= workHours[0] && s.h < workHours[1];
  return { weekday: DAYS[s.dow], date: s.date, isWorkday, duringWorkHours };
}

/**
 * Cross-check the weekday the model MEANT against the date it actually wrote.
 * Returns null when they agree (or no weekday was given), else a correction that
 * names the real weekday and the next two dates that ARE the intended weekday.
 */
export function checkWeekday(start, intended, { today = null } = {}) {
  if (!intended) return null;
  const s = wallClock(start);
  if (!s) return null;
  const key = String(intended).trim().toLowerCase().slice(0, 3);
  const want = DAYS.findIndex((d) => d.toLowerCase().startsWith(key));
  if (want < 0 || want === s.dow) return null;
  let hint = "";
  const t = wallClock(today);
  if (t) {
    const base = Date.UTC(t.y, t.mo - 1, t.d) + ((want - t.dow + 7) % 7) * 864e5;
    hint = ` The upcoming ${DAYS[want]}s are ${isoOf(base)} and ${isoOf(base + 7 * 864e5)}.`;
  }
  return `Date/weekday mismatch: ${s.date} is a ${DAYS[s.dow]}, not a ${DAYS[want]}.${hint} Look the date up in the date reference and call again with the right one.`;
}

/** True if the event's date is before today (e.g. the wrong year). */
export function isBeforeToday(start, today) {
  const s = wallClock(start), t = wallClock(today);
  return Boolean(s && t && s.date < t.date);
}

/**
 * The authoritative day-to-date table injected into Lloyd's context, so resolving
 * "Tuesday", "next Thursday" or "the 20th" is a lookup, never arithmetic.
 */
export function dateReference(now = new Date(), tz = SCHEDULE.tz, days = 21) {
  const t = wallClock(todayISO(now, tz));
  const base = Date.UTC(t.y, t.mo - 1, t.d);
  const lines = [];
  for (let i = 0; i < days; i++) {
    const ms = base + i * 864e5;
    const dt = new Date(ms);
    const tag = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    lines.push(`${DAYS[dt.getUTCDay()].slice(0, 3)} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()} = ${isoOf(ms)}${tag}`);
  }
  return `Date reference (AUTHORITATIVE. Look weekdays and dates up here; never compute them yourself):\n${lines.join("\n")}`;
}

/** Which family members an invitee list covers, by FAMILY_PEOPLE. */
export function personsFor(attendees, people = FAMILY_PEOPLE) {
  const list = (Array.isArray(attendees) ? attendees : String(attendees || "").split(/[,;]/))
    .map((a) => String(a).toLowerCase().trim())
    .filter(Boolean);
  return Object.entries(people)
    .filter(([, addrs]) => list.some((a) => addrs.includes(a)))
    .map(([person]) => person);
}
