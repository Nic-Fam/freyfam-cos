import { getCommuteTime, zonedInstant } from "./commute.js";

// ===========================================================================
// "When do I need to leave?" (ported from the legacy assistant). Combines the
// live commute time (Azure Maps) with a buffer to compute a leave-by instant for
// an appointment. Pairs with reminders: the leave_by tool can arm a reminder at
// that time so Lloyd nudges the family proactively.
// ===========================================================================

const DEFAULT_BUFFER_MIN = Number(process.env.LEAVE_BY_BUFFER_MIN ?? 10);

/**
 * Compute when to leave to arrive on time. `arriveBy` is a wall-clock time in the
 * family timezone ("2026-06-25T14:00") or any ISO instant. The drive is priced on
 * PREDICTED traffic for the actual trip (we ask the router to arrive `bufferMin`
 * early), not on whatever traffic exists at the moment the family asks.
 * `commute` is injectable for tests; defaults to Azure Maps. Returns
 * { leaveBy (ISO), driveMin, bufferMin, trafficLabel, distanceMiles, basis }.
 */
export async function computeLeaveBy({ origin, destination, arriveBy, bufferMin = DEFAULT_BUFFER_MIN, commute = getCommuteTime } = {}) {
  if (!origin || !destination) throw new Error("origin and destination are required");
  const arrive = zonedInstant(arriveBy);
  if (!arrive || Number.isNaN(arrive.getTime())) throw new Error("arriveBy must be a valid datetime");
  const target = new Date(arrive.getTime() - bufferMin * 60000);
  const r = await commute(origin, destination, { arriveBy: target.toISOString() });
  const leaveMs = r.departAt instanceof Date && !Number.isNaN(r.departAt.getTime())
    ? r.departAt.getTime()
    : arrive.getTime() - (r.minutes + bufferMin) * 60000;
  return {
    leaveBy: new Date(leaveMs).toISOString(),
    driveMin: r.minutes,
    bufferMin,
    trafficLabel: r.trafficLabel,
    distanceMiles: r.distanceMiles,
    basis: r.basis || "live",
  };
}
