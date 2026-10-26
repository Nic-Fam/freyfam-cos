import { SCHEDULE, CALENDAR, FAMILY_PEOPLE, WORK_DOMAINS } from "./config.js";
import { dayPlan } from "./schedule.js";
import { wallClock, todayISO } from "./calendar-facts.js";
import { routeLeg, zonedInstant, clockLabel } from "./commute.js";

// ===========================================================================
// The calendar-driven day planner behind the morning digest (2026-10-26).
//
// Before this, the digest's shape came from FIXED weekday rules (schedule.js):
// Nic commutes Mon-Fri, Shelli works from home Fridays, Woodbury runs Mon-Fri.
// PTO, a sick day, a Woodbury closure, a trip, or a 9:30 appointment before work
// only changed the digest if the model happened to notice them while composing,
// and every commute was priced on whatever traffic existed at 6am.
//
// Now the day is planned in CODE from today's calendar:
//   1. planDay (pure): who is in-office / home / off / away, whether daycare runs,
//      each person's away-from-home commitments, and the trips that follow from
//      them (chained through daycare drop-off when it applies).
//   2. priceTrips (async): every trip is routed with arrive-by timing on PREDICTED
//      traffic for when it actually happens, giving a real leave-by time, and
//      back-to-back commitments that can't both be made are flagged.
// The digest hands the result to Lloyd as ground truth instead of asking him to
// work it out with tools. Calendar signals are keyword-based and conservative:
// anything unclear keeps the weekday default.
// ===========================================================================

const OFF_RE = /\b(pto|ooo|out of (the )?office|vacation|day off|sick( day)?|off work|personal day|on leave|bereavement)\b/i;
const HOLIDAY_RE = /\b(holiday|company closed|office closed)\b/i;
const WFH_RE = /\b(wfh|work(ing)? from home|remote day|home office day)\b/i;
const OFFICE_RE = /\b(in[- ]office|office day|on[- ]?site|in person at (the )?office)\b/i;
const AWAY_RE = /\b(flight|flying|fly to|trip|travel(ing|ling)?|conference|offsite|off-site|out of town)\b/i;
const DAYCARE_RE = /\b(woodbury|preschool|pre-school|daycare|day care)\b/i;
const CLOSED_RE = /\b(closed|closure|no school|holiday|break|in[- ]service|staff (development|training|day)|teacher (work|planning|prep) day|non[- ]student day)\b/i;
const FOX_HOME_RE = /\bfox\b.*\b(sick|home today|stays? home|staying home|off)\b|\b(sick|home)\b.*\bfox\b/i;
const VIRTUAL_RE = /\b(teams|zoom|google meet|meet\.google|webex|microsoft teams|phone|call|online|virtual|facetime)\b|https?:\/\//i;
const HOME_WORDS_RE = /^\s*(home|house|our house|at home)\s*$/i;

const pad = (n) => String(n).padStart(2, "0");
const keyOf = (name) => String(name || "").toLowerCase();

function minutesOf(wall) {
  const w = wallClock(wall);
  return w && w.hasTime ? w.h * 60 + w.mi : null;
}
function wallAt(date, hhmm) {
  return `${date}T${hhmm}:00`;
}
function fmtClock(wall) {
  const w = wallClock(wall);
  if (!w || !w.hasTime) return "";
  return `${w.h % 12 || 12}:${pad(w.mi)} ${w.h >= 12 ? "PM" : "AM"}`;
}

/** All-day (or spans the whole of today) rather than a timed slot. Pure. */
export function isAllDayToday(e, today) {
  const s = wallClock(e?.start), en = wallClock(e?.end);
  if (!s) return false;
  if (s.date < today && (!en || en.date > today || (en.date === today && en.hasTime && (en.h > 0 || en.mi > 0)))) return true;
  if (s.date !== today) return false;
  if (!s.hasTime || (s.h === 0 && s.mi === 0 && en && en.date > today)) return true;
  return false;
}

/** Does the event touch today at all? Pure. */
export function isToday(e, today) {
  const s = wallClock(e?.start), en = wallClock(e?.end);
  if (!s) return false;
  if (s.date === today) return true;
  return s.date < today && en && (en.date > today || (en.date === today && en.hasTime && (en.h > 0 || en.mi > 0)));
}

/** A physical place someone has to drive to (not virtual, not home). Pure. */
export function isPhysicalLocation(loc, homeAddress = null) {
  const l = String(loc || "").trim();
  if (!l) return false;
  if (VIRTUAL_RE.test(l)) return false;
  if (HOME_WORDS_RE.test(l)) return false;
  if (homeAddress && l.toLowerCase().replace(/\W+/g, "") === homeAddress.toLowerCase().replace(/\W+/g, "")) return false;
  return true;
}

/**
 * Whose event is this? Ordered by how much the signal can be trusted:
 *   1. a family name in the subject ("Shelli PTO", "Nic's dentist", "Fox: pediatrician")
 *   2. exactly one parent among the attendees
 *   3. exactly one parent's calendar it is on
 * Lloyd creates every event on one calendar and the house rules add both work
 * addresses to workday appointments, so calendar and attendees alone are often
 * ambiguous; an ambiguous event is returned with shared:true rather than guessed.
 * Pure. @returns {{people:string[], shared:boolean, fox:boolean}}
 */
export function attributeEvent(e, { parents = SCHEDULE.people.map((p) => keyOf(p.name)), familyPeople = FAMILY_PEOPLE } = {}) {
  const subject = String(e?.subject || "");
  const fox = /\bfox('s)?\b/i.test(subject);
  const named = parents.filter((k) => new RegExp(`\\b${k}('s)?\\b`, "i").test(subject));
  if (named.length) return { people: named, shared: named.length > 1, fox };
  const attendees = (e?.attendees || []).map((a) => String(a).toLowerCase());
  const byAttendee = parents.filter((k) => (familyPeople[k] || []).some((addr) => attendees.includes(addr)));
  if (byAttendee.length === 1) return { people: byAttendee, shared: false, fox };
  const byCal = parents.filter((k) => (e?.calendars || []).map(keyOf).includes(k));
  if (!byAttendee.length && byCal.length === 1) return { people: byCal, shared: false, fox };
  const all = [...new Set([...byAttendee, ...byCal])];
  return { people: all.length ? all : parents, shared: true, fox };
}

function isWorkMeeting(e, workDomains = WORK_DOMAINS) {
  return (e?.attendees || []).some((a) => workDomains.includes(String(a).split("@").pop().toLowerCase()));
}

/**
 * Plan today from the calendar. Pure (no network): `events` is today's merged
 * list_calendar output. Returns who is doing what, whether daycare runs, the
 * human-readable reasons, and the trips to price.
 */
export function planDay({ events = [], now = new Date(), tz = SCHEDULE.tz, sched = SCHEDULE, workHours = CALENDAR.workHours } = {}) {
  const today = todayISO(now, tz);
  const base = dayPlan(now, tz, sched);
  const todays = (events || []).filter((e) => isToday(e, today) && String(e?.showAs || "").toLowerCase() !== "free");
  const parents = sched.people.map((p) => keyOf(p.name));
  const notes = [];

  // --- daycare ---------------------------------------------------------------
  const daycare = { runs: base.daycare, reason: base.daycare ? "regular school day" : base.isWeekend ? "weekend" : "not a school day" };
  if (daycare.runs) {
    const closure = todays.find((e) => DAYCARE_RE.test(String(e.subject || "")) && CLOSED_RE.test(String(e.subject || "")));
    const foxHome = todays.find((e) => FOX_HOME_RE.test(String(e.subject || "")));
    if (closure) {
      daycare.runs = false;
      daycare.reason = `"${closure.subject}" is on the calendar`;
      notes.push(`${sched.daycareName} is closed today ("${closure.subject}"): no drop-off and no school-day note for Fox.`);
    } else if (foxHome) {
      daycare.runs = false;
      daycare.reason = `"${foxHome.subject}" is on the calendar`;
      notes.push(`Fox is home today ("${foxHome.subject}"): no drop-off.`);
    }
  }

  // --- each person's status ----------------------------------------------------
  const people = sched.people.map((p) => {
    const key = keyOf(p.name);
    const isWorkDay = sched.workDays.includes(base.dow);
    const wfh = (p.wfhDays || []).includes(base.dow);
    let status = !isWorkDay ? "home" : wfh ? "home" : "in-office";
    let reason = !isWorkDay ? (base.isWeekend ? "weekend" : "not a work day") : wfh ? "regular work-from-home day" : "regular office day";
    const mine = todays.filter((e) => {
      const a = attributeEvent(e, { parents });
      return a.people.includes(key) && !a.shared;
    });
    const allDay = mine.filter((e) => isAllDayToday(e, today));
    const marker = (re) => allDay.find((e) => re.test(String(e.subject || "")));
    const away = marker(AWAY_RE);
    const off = marker(OFF_RE) || (isWorkDay ? marker(HOLIDAY_RE) : null);
    const wfhMark = mine.find((e) => WFH_RE.test(String(e.subject || "")));
    const officeMark = mine.find((e) => OFFICE_RE.test(String(e.subject || "")));
    if (away) {
      status = "away"; reason = `"${away.subject}" is on the calendar`;
      notes.push(`${p.name} is away today ("${away.subject}"): no commute or home-based travel for ${p.name}.`);
    } else if (off && isWorkDay) {
      status = "off"; reason = `"${off.subject}" is on the calendar`;
      notes.push(`${p.name} is off work today ("${off.subject}"): no work commute or work weather for ${p.name}.`);
    } else if (status === "in-office" && wfhMark) {
      status = "home"; reason = `"${wfhMark.subject}" is on the calendar`;
      notes.push(`${p.name} is working from home today ("${wfhMark.subject}").`);
    } else if (status === "home" && isWorkDay && officeMark) {
      status = "in-office"; reason = `"${officeMark.subject}" is on the calendar`;
      notes.push(`${p.name} is going in to the office today ("${officeMark.subject}"), not the usual work-from-home day.`);
    }

    // Work start: an earlier work meeting (work-domain attendees, no physical
    // location) moves the start up; otherwise the configured start time.
    let workStart = p.workStart || "09:00";
    if (status === "in-office") {
      const cfgStart = minutesOf(wallAt(today, workStart));
      const early = mine
        .filter((e) => !isAllDayToday(e, today) && isWorkMeeting(e) && !isPhysicalLocation(e.location, sched.homeAddress))
        .map((e) => minutesOf(e.start))
        .filter((m) => m != null && m >= workHours[0] * 60 - 120 && m < cfgStart)
        .sort((a, b) => a - b)[0];
      if (early != null) workStart = `${pad(Math.floor(early / 60))}:${pad(early % 60)}`;
    }

    const commitments = mine
      .filter((e) => !isAllDayToday(e, today) && isPhysicalLocation(e.location, sched.homeAddress) && wallClock(e.start)?.date === today)
      .filter((e) => !(p.workAddress && String(e.location).toLowerCase() === p.workAddress.toLowerCase()))
      .map((e) => ({ subject: e.subject, start: e.start, end: e.end, location: String(e.location).trim() }))
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));

    return { name: p.name, key, status, reason, chainedDaycare: Boolean(p.chainedDaycare), workAddress: p.workAddress || null, workStart, commitments };
  });

  // Commitments the calendar can't pin on one person (shared or ambiguous).
  const sharedCommitments = todays
    .filter((e) => attributeEvent(e, { parents }).shared && !isAllDayToday(e, today) && isPhysicalLocation(e.location, sched.homeAddress) && wallClock(e.start)?.date === today)
    .map((e) => ({ subject: e.subject, start: e.start, end: e.end, location: String(e.location).trim() }))
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));

  // --- trips -------------------------------------------------------------------
  const trips = [];
  const home = sched.homeAddress;
  const daycareStop = daycare.runs && sched.daycareAddress ? sched.daycareAddress : null;
  const buffer = Number(sched.travelBufferMin ?? 10);
  let dropoffAssigned = false;

  for (const p of people) {
    if (p.status === "away") continue;
    const stops = [];
    const workStartWall = wallAt(today, p.workStart);
    if (p.status === "in-office") {
      const beforeWork = p.commitments.filter((c) => String(c.start) < workStartWall);
      const first = beforeWork[0];
      if (first) stops.push({ purpose: first.subject, to: first.location, arriveBy: first.start, end: first.end });
      if (p.workAddress) stops.push({ purpose: "work", to: p.workAddress, arriveBy: first ? null : workStartWall, afterStop: Boolean(first) });
      for (const c of p.commitments) if (c !== first) stops.push({ purpose: c.subject, to: c.location, arriveBy: c.start, end: c.end });
    } else {
      for (const c of p.commitments) stops.push({ purpose: c.subject, to: c.location, arriveBy: c.start, end: c.end });
    }

    const chained = p.chainedDaycare && daycareStop && !dropoffAssigned;
    if (chained) {
      dropoffAssigned = true;
      const firstStop = stops.find((s) => s.arriveBy);
      const firstMin = firstStop ? minutesOf(firstStop.arriveBy) : null;
      const dropMin = minutesOf(wallAt(today, sched.daycareDropoff));
      // Chain drop-off into the first trip when that trip starts within ~2h of
      // drop-off; otherwise drop-off is its own round trip from home.
      if (firstStop && firstMin != null && firstMin - dropMin <= 120 && firstMin >= dropMin) firstStop.via = daycareStop;
      else stops.unshift({ purpose: `drop Fox at ${sched.daycareName}`, to: daycareStop, arriveBy: wallAt(today, sched.daycareDropoff), isDropoff: true });
    }

    let prev = { place: home, end: null };
    for (const s of stops) {
      if (!s.arriveBy) {
        // "Work after a morning appointment": leave when the appointment ends.
        trips.push({ who: p.name, purpose: s.purpose, from: prev.place, to: s.to, departAfter: prev.end, bufferMin: 0 });
        prev = { place: s.to, end: null };
        continue;
      }
      // Coming from the previous stop if it ends within 90 minutes, else from
      // work (in-office, during work hours) or home.
      const gap = prev.end ? minutesOf(s.arriveBy) - minutesOf(prev.end) : null;
      const inWorkHours = (() => { const m = minutesOf(s.arriveBy); return m != null && m >= workHours[0] * 60 && m < workHours[1] * 60; })();
      const from = prev.end && gap != null && gap <= 90 ? prev.place
        : p.status === "in-office" && p.workAddress && inWorkHours && prev.place !== home ? p.workAddress
        : prev.place || home;
      trips.push({
        who: p.name, purpose: s.purpose, from, to: s.to, via: s.via || null,
        arriveBy: s.arriveBy, bufferMin: s.isDropoff ? 0 : buffer, prevEnd: prev.end, prevPurpose: prev.purpose || null,
      });
      prev = { place: s.isDropoff ? home : s.to, end: s.isDropoff ? null : s.end || null, purpose: s.purpose };
      if (s.isDropoff) prev.place = home;
    }
  }
  if (daycareStop && !dropoffAssigned) {
    notes.push(`${sched.daycareName} is open but the usual drop-off driver is away: who is taking Fox?`);
  }
  for (const c of sharedCommitments) {
    trips.push({ who: "Nic or Shelli (the calendar doesn't say who)", purpose: c.subject, from: home, to: c.location, arriveBy: c.start, bufferMin: buffer });
  }

  // --- weather stops -----------------------------------------------------------
  const weatherStops = [];
  const addStop = (label, address) => {
    if (address && !weatherStops.some((w) => w.address.toLowerCase() === address.toLowerCase())) weatherStops.push({ label, address });
  };
  addStop("Home", home);
  if (daycareStop) addStop(sched.daycareName, daycareStop);
  for (const p of people) if (p.status === "in-office") addStop(`${p.name}'s work`, p.workAddress);
  for (const t of trips) addStop(t.purpose, t.to);

  // Human label for each origin, so the digest says "leave home" / "leave work".
  const workOf = Object.fromEntries(people.map((p) => [p.name, p.workAddress]));
  for (const t of trips) {
    t.fromLabel = t.from === home ? "home" : t.from && t.from === workOf[t.who] ? "work" : t.from;
  }

  return {
    date: today,
    isWeekend: base.isWeekend,
    daycare,
    people,
    sharedCommitments,
    notes,
    trips: trips.filter((t) => t.from && t.to).slice(0, 10),
    weatherStops: weatherStops.slice(0, 6),
    routable: Boolean(home),
  };
}

/**
 * Price every planned trip on PREDICTED traffic for when it happens (arrive-by
 * routing, buffer included), chaining through daycare where planned. Flags a trip
 * whose leave time falls before the previous commitment ends. Never throws: a
 * trip that can't be routed comes back with `error` so the digest can say so.
 * `route` injectable for tests.
 */
export async function priceTrips(plan, { route = routeLeg, now = new Date(), tz = SCHEDULE.tz, dwellMin = SCHEDULE.dropoffDwellMin, daycareDropoff = SCHEDULE.daycareDropoff } = {}) {
  const out = [];
  let lastDeparture = null; // for "work after appointment" legs
  for (const t of plan?.trips || []) {
    try {
      if (!t.arriveBy) {
        const dep = t.departAfter ? zonedInstant(t.departAfter, tz) : lastDeparture;
        const r = await route(t.from, t.to, { departAt: dep, now });
        out.push({ ...t, ok: true, leaveAt: r.departAt, arriveAt: r.arriveAt, minutes: r.minutes, delayMins: r.delayMins, trafficLabel: r.trafficLabel, basis: r.basis });
        continue;
      }
      const arrive = zonedInstant(t.arriveBy, tz);
      const target = new Date(arrive.getTime() - (t.bufferMin || 0) * 60000);
      let leaveAt, minutes, delayMins, trafficLabel, basis;
      if (t.via) {
        // Second leg first (daycare -> destination), then the drop-off leg timed to
        // reach daycare by drop-off time or early enough to make the second leg.
        const leg2 = await route(t.via, t.to, { arriveAt: target, now });
        const dropTarget = zonedInstant(`${plan.date}T${daycareDropoff}:00`, tz);
        const latestAtDaycare = new Date(leg2.departAt.getTime() - (dwellMin || 0) * 60000);
        const leg1Arrive = dropTarget && dropTarget < latestAtDaycare ? dropTarget : latestAtDaycare;
        const leg1 = await route(t.from, t.via, { arriveAt: leg1Arrive, now });
        leaveAt = leg1.departAt;
        minutes = leg1.minutes + leg2.minutes;
        delayMins = (leg1.delayMins || 0) + (leg2.delayMins || 0);
        trafficLabel = delayMins >= 15 ? "heavy traffic" : delayMins >= 5 ? "moderate traffic" : "light traffic";
        basis = leg1.basis === "predicted" && leg2.basis === "predicted" ? "predicted" : "live";
      } else {
        const r = await route(t.from, t.to, { arriveAt: target, now });
        ({ minutes, delayMins, trafficLabel, basis } = r);
        leaveAt = r.departAt;
      }
      lastDeparture = arrive;
      const prevEnd = t.prevEnd ? zonedInstant(t.prevEnd, tz) : null;
      const conflict = prevEnd && leaveAt < prevEnd
        ? `${t.prevPurpose || "the previous commitment"} ends at ${clockLabel(prevEnd, tz)}, but leaving by ${clockLabel(leaveAt, tz)} is needed to make ${t.purpose}`
        : null;
      out.push({ ...t, ok: true, leaveAt, arriveAt: arrive, minutes, delayMins, trafficLabel, basis, conflict });
    } catch (e) {
      out.push({ ...t, ok: false, error: String(e?.message || e) });
    }
  }
  return out;
}

/** One digest-ready line per priced trip. Pure. */
export function formatTripLine(r, { tz = SCHEDULE.tz, daycareName = SCHEDULE.daycareName } = {}) {
  if (!r.ok) return `${r.who}: ${r.purpose} at ${r.to} (could not price the drive: ${r.error})`;
  const leave = clockLabel(r.leaveAt, tz);
  const via = r.via ? `, drop Fox at ${daycareName} on the way` : "";
  const by = r.arriveBy ? ` for ${r.purpose} at ${fmtClock(r.arriveBy)}` : ` to ${r.purpose === "work" ? "work" : r.purpose}`;
  const delay = r.delayMins > 0 ? `, ${r.delayMins} min slower than empty roads` : "";
  const est = r.basis === "predicted" ? "predicted for that time" : "current traffic";
  const flag = r.conflict ? ` TIGHT: ${r.conflict}.` : "";
  const from = r.fromLabel === "home" || r.fromLabel === "work" ? r.fromLabel : `from ${r.fromLabel || r.from}`;
  return `${r.who}: leave ${from} by ${leave}${by}${via} (${r.minutes} min, ${r.trafficLabel}${delay}; ${est}).${flag}`;
}
