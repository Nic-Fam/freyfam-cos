// ===========================================================================
// CVS prescription sync planning (deterministic core). Goal (per Nic): get the
// regular Rx onto ONE monthly delivery by delaying the early refills until they
// are all in the same window — WITHOUT letting any sit so long the pharmacy
// returns it to stock. Then deliver all the regular meds together each month.
//
// This module is the planner: given each med's next ready date and its
// return-to-stock deadline, it picks the synced delivery date, says which to
// hold, and flags any that cannot wait. The live CVS actions (delay a shipment,
// set monthly auto-delivery) are browser automation that plugs in after live
// testing; they touch health + money, so they stay behind the confirmation gate.
//
// Med shape: { name, readyDate: "YYYY-MM-DD", returnByDate: "YYYY-MM-DD" }
//   readyDate    = when the next fill is ready to ship
//   returnByDate = last day to ship/pick up before CVS returns it to stock
// ===========================================================================

/**
 * Plan a synced monthly delivery. Pure.
 * Returns {
 *   feasible,            // can ALL ready meds ship together with none returned?
 *   deliverOn,           // target synced delivery date (YYYY-MM-DD) or null
 *   hold: [med],         // ready early, safe to wait until deliverOn
 *   readyOnTarget: [med],// already ready right at the target
 *   conflicts: [med],    // would be returned to stock before deliverOn -> handle separately
 *   note,
 * }
 */
export function planRxSync(meds = [], { today } = {}) {
  const dated = (meds || []).filter((m) => m && m.name && /^\d{4}-\d{2}-\d{2}$/.test(m.readyDate || ""));
  if (!dated.length) return { feasible: true, deliverOn: null, hold: [], readyOnTarget: [], conflicts: [], note: "No regular refills with a ready date to sync." };

  // Sync to the LATEST ready date so every med is filled by then (one batch).
  const deliverOn = dated.reduce((mx, m) => (m.readyDate > mx ? m.readyDate : mx), dated[0].readyDate);

  const hold = [];
  const readyOnTarget = [];
  const conflicts = [];
  for (const m of dated) {
    // A med with a return-to-stock deadline BEFORE the synced date can't wait.
    if (m.returnByDate && m.returnByDate < deliverOn) conflicts.push(m);
    else if (m.readyDate < deliverOn) hold.push(m); // ready early, delay shipment to the synced date
    else readyOnTarget.push(m);
  }

  const feasible = conflicts.length === 0;
  const note = feasible
    ? `Deliver all ${dated.length} together on ${deliverOn}; hold ${hold.length} earlier refill(s) until then.`
    : `${conflicts.length} med(s) would be returned to stock before ${deliverOn} — ship those by their return-by date (or ask CVS to realign the fill date) and sync the rest.`;
  return { feasible, deliverOn, hold, readyOnTarget, conflicts, note };
}

/** Human summary of a sync plan. */
export function formatRxPlan(plan) {
  if (!plan || !plan.deliverOn) return plan?.note || "Nothing to sync.";
  const names = (a) => a.map((m) => m.name).join(", ") || "none";
  const lines = [
    `Synced delivery: ${plan.deliverOn} (${plan.feasible ? "all together" : "partial — see conflicts"}).`,
    `Hold until then: ${names(plan.hold)}.`,
    `Ready on the date: ${names(plan.readyOnTarget)}.`,
  ];
  if (plan.conflicts.length) lines.push(`Can't wait (would be returned to stock): ${names(plan.conflicts)} — handle separately.`);
  return lines.join("\n");
}
