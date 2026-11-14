// Calendar policy: how a proposed event becomes a real one.
//
// Two rules the family asked for, kept here as PURE functions so they are
// testable without Graph:
//
//   1. DON'T DUPLICATE. If a proposed event looks like one already on the
//      calendar (same day, near the same time, recognizably the same subject),
//      the right move is to UPDATE that event, not add a second copy. The
//      orchestrator uses findDuplicateEvent + eventPatch to switch a create
//      into an update.
//
//   2. DEFAULT TO THE FAMILY. Anything Lloyd puts on the calendar is a family
//      event by default: the other spouse is invited on their personal address,
//      and a weekday-daytime appointment also copies the work calendars (the
//      long-standing house rule). The single exemption is an explicit "keep this
//      off the family calendar" — the create tool passes familyCalendar:false
//      and we add nobody.
//
// Both are deliberately conservative: near-miss subjects do NOT match (a wrong
// merge silently eats a real event), and defaulting never REMOVES an attendee
// the caller asked for.

// Same convention as graph.js / obligations.js: the family timezone is read
// straight from the environment rather than imported, so this module stays pure
// and importable in tests without config side effects.
const FAMILY_TZ = process.env.FAMILY_TZ || "America/Los_Angeles";

// Household (personal) addresses. Work addresses are attached per person so a
// daytime appointment lands on the work calendar too.
export const FAMILY_CALENDAR_PEOPLE = [
  { name: "Nic", personal: "nic@freyfam.com", work: "nicholas.frey@flyerdefense.com", workStart: 9, workEnd: 17 },
  { name: "Shelli", personal: "shelli@freyfam.com", work: "shelli.frey@disney.com", workStart: 9, workEnd: 17 },
];

const norm = (s) => String(s || "").toLowerCase().trim();

// Words that carry no identity for an event title, so "Dentist appointment" and
// "Dentist appt" are the same thing. Kept small on purpose.
const STOPWORDS = new Set([
  "a", "an", "the", "at", "on", "in", "for", "with", "to", "of", "and",
  "appt", "appointment", "meeting", "call", "visit", "session", "event",
]);

/** Title -> comparable token set. Pure. */
export function subjectTokens(subject) {
  return new Set(
    norm(subject)
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOPWORDS.has(w))
  );
}

/**
 * Do two titles name the same thing? True when either token set contains the
 * other (so "Dentist" matches "Dentist appointment for Fox") or they overlap
 * heavily (Jaccard >= 0.6). Pure.
 */
export function subjectsMatch(a, b) {
  const ta = subjectTokens(a);
  const tb = subjectTokens(b);
  if (!ta.size || !tb.size) return norm(a) === norm(b) && !!norm(a);
  const shared = [...ta].filter((w) => tb.has(w)).length;
  if (!shared) return false;
  // One title contains the other ("Dentist" inside "Fox dentist visit"). Guard
  // the lopsided case: a single shared word is not enough to merge "Dentist"
  // into "Dentist billing call with Aetna" — that would eat a real event.
  if (shared === ta.size || shared === tb.size) {
    const small = Math.min(ta.size, tb.size);
    const large = Math.max(ta.size, tb.size);
    if (small >= 2 || large <= 2) return true;
  }
  return shared / (ta.size + tb.size - shared) >= 0.6;
}

/** YYYY-MM-DD in the family timezone, or null if unparseable. Pure-ish (Intl). */
export function localDayKey(value, tz = FAMILY_TZ) {
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(t));
}

/**
 * Find the event a proposal is a re-statement of, so we update instead of
 * duplicating. Requires ALL of:
 *   - the same local calendar day,
 *   - starts within `withinMinutes` of each other (default 3h — "the dentist at
 *     2" vs "the dentist at 3:30" is the same appointment being corrected),
 *   - matching subjects (subjectsMatch).
 * A candidate with no usable start or no refs is skipped (we could not update it
 * anyway). Returns { event, why } or null. Pure.
 */
export function findDuplicateEvent({ proposed, events = [], withinMinutes = 180, tz = FAMILY_TZ } = {}) {
  const day = localDayKey(proposed?.start, tz);
  const t = Date.parse(String(proposed?.start));
  if (!day || Number.isNaN(t)) return null;

  let best = null;
  for (const e of events) {
    if (!e || !Array.isArray(e.refs) || !e.refs.length) continue;
    const et = Date.parse(String(e.start));
    if (Number.isNaN(et)) continue;
    if (localDayKey(e.start, tz) !== day) continue;
    const driftMin = Math.abs(et - t) / 60000;
    if (driftMin > withinMinutes) continue;
    if (!subjectsMatch(proposed.subject, e.subject)) continue;
    if (!best || driftMin < best.driftMin) {
      best = {
        driftMin,
        event: e,
        why: driftMin < 1
          ? `already on the calendar at the same time`
          : `already on the calendar ${Math.round(driftMin)} min ${et < t ? "earlier" : "later"}`,
      };
    }
  }
  return best ? { event: best.event, why: best.why } : null;
}

/**
 * What would actually change if we folded `proposed` into `existing`? Returns a
 * patch of only the differing fields (attendees are a UNION — an update never
 * un-invites anyone), or null when the existing event already says all of it.
 * Pure.
 */
export function eventPatch(proposed, existing) {
  const patch = {};
  const sameInstant = (a, b) => {
    const ta = Date.parse(String(a));
    const tb = Date.parse(String(b));
    return !Number.isNaN(ta) && !Number.isNaN(tb) && ta === tb;
  };

  if (proposed.start && !sameInstant(proposed.start, existing.start)) patch.start = proposed.start;
  const proposedEnd = proposed.end || proposed.start;
  if (proposedEnd && existing.end && !sameInstant(proposedEnd, existing.end)) patch.end = proposedEnd;
  if (proposed.location && norm(proposed.location) !== norm(existing.location)) patch.location = proposed.location;
  if (proposed.showAs && norm(proposed.showAs) !== norm(existing.showAs)) patch.showAs = proposed.showAs;
  if (proposed.subject && norm(proposed.subject) !== norm(existing.subject)) patch.subject = proposed.subject;

  const have = new Set((existing.attendees || []).map(norm));
  const adding = (proposed.attendees || []).map(norm).filter((a) => a && !have.has(a));
  if (adding.length) patch.attendees = [...new Set([...(existing.attendees || []), ...adding])];

  return Object.keys(patch).length ? patch : null;
}

// Local hour (0-23) and weekday (0=Sun..6=Sat) in the family timezone.
function localHour(value, tz) {
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) return null;
  const h = parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date(t)),
    10
  );
  return Number.isFinite(h) ? (h === 24 ? 0 : h) : null;
}
function localWeekday(value, tz) {
  const t = Date.parse(String(value));
  if (Number.isNaN(t)) return null;
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(t))];
}

/**
 * Apply the family default: invite both spouses on their personal addresses,
 * plus their work addresses when the event falls in the weekday work window
 * (the standing house rule). The organizer's own mailbox is never listed as an
 * attendee (it owns the event). Anything the caller already passed is kept.
 *
 * familyCalendar:false is the exemption — "keep this off the family calendar" —
 * and returns the input's attendees untouched.
 *
 * Pure. Returns a new input object; never mutates.
 */
export function withFamilyDefaults(
  input = {},
  { organizer = "nic@freyfam.com", familyCalendar = true, people = FAMILY_CALENDAR_PEOPLE, tz = FAMILY_TZ } = {}
) {
  const given = (Array.isArray(input.attendees) ? input.attendees : []).filter(Boolean);
  if (familyCalendar === false) return { ...input, attendees: given };

  const org = norm(organizer);
  const seen = new Set(given.map(norm));
  const out = [...given];
  const add = (addr) => {
    const a = norm(addr);
    if (!a || a === org || seen.has(a)) return;
    seen.add(a);
    out.push(addr);
  };

  const hour = localHour(input.start, tz);
  const dow = localWeekday(input.start, tz);
  const isWeekday = dow != null && dow !== 0 && dow !== 6;

  for (const p of people) {
    add(p.personal);
    // Work calendars only for weekday-daytime events: a Saturday birthday party
    // has no business on a Disney calendar.
    if (isWeekday && hour != null && hour >= p.workStart && hour < p.workEnd) add(p.work);
  }
  return { ...input, attendees: out };
}
