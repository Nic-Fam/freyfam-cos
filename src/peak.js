// ===========================================================================
// Electricity peak hours (2026-11-11). The family's utility charges peak rates
// 4-9pm Los Angeles time every day, so Lloyd keeps HEAVY scheduled work out of
// that window: the Chrome-driven resale/boutique checks, the Amazon order crawl,
// and the off-site backup are deferred until it ends, and an idle Chrome is
// closed while it lasts. Anything the family asks for, and every light job
// (messages, reminders, approvals, the 5:30pm package digest, the heartbeat), runs
// as usual: 4-9pm is when the family is most active.
//
// PEAK_HOURS="16-21" (local start hour inclusive, end hour exclusive, in FAMILY_TZ).
// Set it to "off" to disable. A window that wraps midnight ("22-6") also works.
// ===========================================================================

/** Parse "16-21" -> {start:16, end:21}; "off"/"" -> null. Pure. */
export function parsePeakHours(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s || s === "off" || s === "none" || s === "false") return null;
  const m = s.match(/^(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?$/);
  if (!m) return null;
  const start = Number(m[1]), end = Number(m[2]);
  if (start > 23 || end > 24 || start === end) return null;
  return { start, end };
}

export const PEAK = {
  hours: parsePeakHours(process.env.PEAK_HOURS ?? "16-21"),
  tz: process.env.FAMILY_TZ || "America/Los_Angeles",
};

/** Local hour (0-23) and minute in a timezone. Pure. */
export function localClock(now = new Date(), tz = PEAK.tz) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  return { hour: Number(parts.find((p) => p.type === "hour").value) % 24, minute: Number(parts.find((p) => p.type === "minute").value) };
}

/** Is `now` inside the peak window? Pure. */
export function inPeak(now = new Date(), { hours = PEAK.hours, tz = PEAK.tz } = {}) {
  if (!hours) return false;
  const { hour } = localClock(now, tz);
  return hours.start < hours.end
    ? hour >= hours.start && hour < hours.end
    : hour >= hours.start || hour < hours.end; // wraps midnight
}

/** Is a local minute-of-day inside the peak window? Pure. */
export function minuteInPeak(minutesOfDay, hours = PEAK.hours) {
  if (!hours) return false;
  const h = Math.floor(minutesOfDay / 60);
  return hours.start < hours.end ? h >= hours.start && h < hours.end : h >= hours.start || h < hours.end;
}
