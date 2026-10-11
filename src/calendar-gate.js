// 011: decide whether a calendar event is low-stakes enough to AUTO-CREATE (skip
// the confirmation gate) or must stay GATED. This narrowly loosens hard-constraint
// #2 for exactly one class: routine, family-own events. The rule is deliberately
// conservative -- ANY doubt returns { auto:false } and the event goes through the
// normal approval gate, unchanged.
//
// Auto-create ONLY when ALL hold:
//   - a clear, parseable date/time,
//   - every attendee is a family-OWN address (FAMILY_ADDRESSES, which includes the
//     family's own flyerdefense/disney work calendars) -- so no invite email ever
//     reaches an external third party without approval,
//   - a FAMILY MEMBER asked for it (an authenticated inbound sender; `sourceFrom`).
//     A proactive/heartbeat run or any turn with no known sender always gates,
//     even for an attendee-less personal block (policy 2026-10-11: an injected
//     proactive turn must not be able to write to the family's calendars), and
//   - it doesn't overlap an existing event (caller supplies `hasConflict`; a
//     conflict is exactly when a human should look).
import { FAMILY_ADDRESSES } from "./config.js";

const norm = (s) => String(s || "").toLowerCase().trim();
const isFamily = (addr) => FAMILY_ADDRESSES.includes(norm(addr));

/** Pure. @returns {{auto:boolean, why:string}} */
export function calendarGateDecision({ start, attendees = [], sourceFrom = null, hasConflict = false } = {}) {
  if (!start || Number.isNaN(Date.parse(String(start)))) return { auto: false, why: "no clear date/time" };
  const list = (Array.isArray(attendees) ? attendees : String(attendees || "").split(/[,;]/))
    .map(norm)
    .filter(Boolean);
  const external = list.filter((a) => !isFamily(a));
  if (external.length) return { auto: false, why: `external invitee(s): ${external.join(", ")}` };
  if (!isFamily(sourceFrom)) return { auto: false, why: sourceFrom ? "requester is not a family member" : "no authenticated requester (proactive or unknown turn)" };
  if (hasConflict) return { auto: false, why: "overlaps an existing event" };
  return { auto: true, why: list.length ? "family-only invitees, requested by family, no conflict" : "personal block, no conflict" };
}
