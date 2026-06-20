import { WORK_DOMAINS } from "./config.js";

// ===========================================================================
// Outbound policy (updated 2026-06-20). Work domains (flyerdefense.com,
// disney.com) are NO LONGER hard-blocked. Instead:
//   - the family's OWN work addresses may appear as calendar invitees freely;
//   - sending EMAIL to a work domain is allowed but high-stakes, so it routes
//     through the confirmation gate (confirm.js) like any outbound.
// So this module no longer throws; it just classifies recipients so callers can
// flag work-domain sends in the approval prompt. Protection now rests on the
// confirmation gate, not an absolute wall.
// ===========================================================================

function domainsOf(addressOrList) {
  const list = Array.isArray(addressOrList) ? addressOrList : [addressOrList];
  return list
    .map((a) => String(a).toLowerCase())
    .map((a) => (a.includes("@") ? a.split("@").pop() : a))
    .map((d) => d.trim());
}

/** True if any recipient is on a configured work domain (so callers can flag it). */
export function isWorkDomain(recipients) {
  return domainsOf(recipients).some((d) => WORK_DOMAINS.includes(d));
}
