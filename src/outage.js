import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "./log.js";

// ===========================================================================
// Outage-aware restart (workstream R). The heartbeat stamps a LOCAL "last seen"
// each tick. On boot the daemon compares it to now: if the gap is bigger than a
// normal restart (default >30 min), Lloyd was DOWN (power/hardware), so he tells the
// owner he was offline for that window and is catching up — a silent multi-hour gap
// becomes visible. Inbound was safely queued (Azure) and past-due reminders fire on
// the catch-up tick (getDueReminders returns fireAt<=now), so this is just the
// heads-up, not the recovery itself. Local file (not the cloud liveness row) so gap
// detection works even with no connectivity on boot.
// ===========================================================================

const log = createLogger("outage");
const TZ = process.env.FAMILY_TZ || "America/Los_Angeles";
const THRESHOLD_MS = Number(process.env.OUTAGE_THRESHOLD_MS || 30 * 60 * 1000); // >30 min = a real outage, not a restart
const PATH = () => process.env.HEARTBEAT_SEEN_PATH || "./data/heartbeat-seen.json";

export async function getLastSeen() {
  try { return JSON.parse(await readFile(PATH(), "utf8")).at || null; } catch { return null; }
}

export async function setLastSeen(now = new Date()) {
  try {
    await mkdir(dirname(PATH()), { recursive: true });
    await writeFile(PATH(), JSON.stringify({ at: now.toISOString() }, null, 2));
  } catch (err) {
    log.warn("could not persist last-seen (non-fatal)", { reason: String(err?.message || err) });
  }
}

/** Human duration for a gap, rounded sensibly. Pure. */
export function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `about ${min} minute${min === 1 ? "" : "s"}`;
  const hrs = Math.round(min / 60);
  if (hrs < 48) return `about ${hrs} hour${hrs === 1 ? "" : "s"}`;
  const days = Math.round(hrs / 24);
  return `about ${days} day${days === 1 ? "" : "s"}`;
}

function localTime(iso) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(iso));
  } catch { return iso; }
}

/**
 * Decide whether the daemon was offline (pure): given the previously persisted
 * last-seen and now, returns {wasOffline, gapMs}. A missing last-seen (first run
 * ever) is NOT an outage.
 */
export function assessGap(lastSeenIso, now = new Date(), thresholdMs = THRESHOLD_MS) {
  if (!lastSeenIso) return { wasOffline: false, gapMs: 0 };
  const gapMs = now.getTime() - Date.parse(lastSeenIso);
  return { wasOffline: gapMs > thresholdMs, gapMs };
}

/**
 * Boot check: if the last-seen gap exceeds the threshold, tell the owner Lloyd was
 * offline and is catching up. Read-only on the timestamp (the heartbeat's setLastSeen
 * refreshes it); never throws. `notify`/`now` injectable for tests.
 */
export async function checkOutageOnBoot({ now = new Date(), notify } = {}) {
  try {
    const last = await getLastSeen();
    const { wasOffline, gapMs } = assessGap(last, now);
    if (!wasOffline) return { wasOffline: false, gapMs };
    const msg =
      `I'm back online. I was offline from ${localTime(last)} to ${localTime(now.toISOString())} (${formatDuration(gapMs)}). ` +
      `Any messages that came in were safely queued and I'm catching up now, including reminders that came due. ` +
      `Worth a quick glance at anything time-sensitive.`;
    if (notify) await notify(msg);
    log.warn("recovered from offline gap", { sinceIso: last, gapMin: Math.round(gapMs / 60000) });
    return { wasOffline: true, gapMs, sinceIso: last };
  } catch (err) {
    log.error("outage boot-check failed (non-fatal)", { reason: String(err?.message || err) });
    return { wasOffline: false, gapMs: 0 };
  }
}
