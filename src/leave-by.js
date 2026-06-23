import { getCommuteTime } from "./commute.js";

// ===========================================================================
// "When do I need to leave?" (ported from the legacy assistant). Combines the
// live commute time (Azure Maps) with a buffer to compute a leave-by instant for
// an appointment. Pairs with reminders: the leave_by tool can arm a reminder at
// that time so Lloyd nudges the family proactively.
// ===========================================================================

const DEFAULT_BUFFER_MIN = Number(process.env.LEAVE_BY_BUFFER_MIN ?? 10);

/**
 * Compute when to leave to arrive on time. `arriveBy` is an ISO datetime.
 * `commute` is injectable for tests; defaults to live Azure Maps. Returns
 * { leaveBy (ISO), driveMin, bufferMin, trafficLabel, distanceMiles }.
 */
export async function computeLeaveBy({ origin, destination, arriveBy, bufferMin = DEFAULT_BUFFER_MIN, commute = getCommuteTime } = {}) {
  if (!origin || !destination) throw new Error("origin and destination are required");
  const arrive = new Date(arriveBy);
  if (Number.isNaN(arrive.getTime())) throw new Error("arriveBy must be a valid datetime");
  const r = await commute(origin, destination);
  const leaveMs = arrive.getTime() - (r.minutes + bufferMin) * 60000;
  return {
    leaveBy: new Date(leaveMs).toISOString(),
    driveMin: r.minutes,
    bufferMin,
    trafficLabel: r.trafficLabel,
    distanceMiles: r.distanceMiles,
  };
}
