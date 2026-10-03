import { SCHEDULE } from "./config.js";

// ===========================================================================
// What the family's day actually looks like. Pure, timezone-correct, and the
// input that makes the morning digest adaptive rather than templated: the digest
// asks for a commute, work-location weather, or a daycare drop-off ONLY for the
// people doing those things today.
//
// Rules it encodes (configurable in config.SCHEDULE):
//   - weekends: nobody commutes, no daycare, no work-location weather
//   - a work-from-home day (Shelli on Fridays): that person has no commute and
//     no work-location weather, but is still around
//   - Nic's drive is CHAINED through Fox's daycare, but only on daycare days
// ===========================================================================

const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday index (0=Sun..6=Sat) in the family timezone, not UTC. */
export function localWeekday(now = new Date(), tz = SCHEDULE.tz) {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now);
  const i = DOW[label];
  return Number.isInteger(i) ? i : new Date(now).getDay();
}

/**
 * Who is heading out, who is home, and whether daycare runs today.
 * @returns {{dow:number, isWeekend:boolean, daycare:boolean, anyOut:boolean,
 *            out:Array<{name:string,chainedDaycare:boolean}>, home:Array<{name:string,reason:string}>}}
 */
export function dayPlan(now = new Date(), tz = SCHEDULE.tz, sched = SCHEDULE) {
  const dow = localWeekday(now, tz);
  const isWeekend = dow === 0 || dow === 6;
  const isWorkDay = sched.workDays.includes(dow);
  const daycare = sched.daycareDays.includes(dow);

  const out = [];
  const home = [];
  for (const p of sched.people || []) {
    const wfh = (p.wfhDays || []).includes(dow);
    if (!isWorkDay) {
      home.push({ name: p.name, reason: isWeekend ? "weekend" : "not a work day" });
    } else if (wfh) {
      home.push({ name: p.name, reason: "works from home today" });
    } else {
      out.push({ name: p.name, chainedDaycare: Boolean(p.chainedDaycare) });
    }
  }
  return { dow, isWeekend, daycare, anyOut: out.length > 0, out, home };
}
