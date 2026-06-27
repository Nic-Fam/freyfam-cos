// Afternoon package-pickup digest (weekday 5:30pm). Texts the owner what was
// delivered TODAY to the family's pickup location (the UPS Store on Foothill) so
// they can grab it on the way home. Deterministic — reads the package tracker,
// no model. Scheduling mirrors the morning digest but with minute precision
// (5:30 is off the heartbeat's :00/:15 grid) and a weekday gate.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PACKAGE_DIGEST } from "./config.js";
import { notifyOwnerImessage } from "./channels/imessage.js";
import { listDeliveredPickups } from "./packages.js";

const cap = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

// Local {date:"YYYY-MM-DD", minutes:0-1439, weekday:0-6} for a tz.
export function localNow(now, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(now).map((x) => [x.type, x.value])
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  const minutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return { date, minutes, weekday };
}

function localDateOf(iso, tz) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/**
 * Run now? Inside [target, target+window) local minutes, on a weekday (if
 * configured), and not already sent today. Returns the local date to record.
 */
export function shouldRunPackageDigest(now, lastRunDate, cfg = PACKAGE_DIGEST) {
  const { hour = 17, minute = 30, windowMinutes = 60, weekdaysOnly = true, tz = "America/Los_Angeles" } = cfg;
  const { date, minutes, weekday } = localNow(now, tz);
  const target = hour * 60 + minute;
  const inWindow = minutes >= target && minutes < target + windowMinutes;
  const okDay = !weekdaysOnly || (weekday >= 1 && weekday <= 5);
  return { run: okDay && inWindow && lastRunDate !== date, date };
}

// Persisted once-per-day guard (survives restarts), like the morning digest.
const statePath = () => process.env.PACKAGE_DIGEST_STATE_PATH || "./data/package-digest-state.json";
export async function getLastPackageDigestDate() {
  try { return JSON.parse(await readFile(statePath(), "utf8")).lastRunDate || null; } catch { return null; }
}
export async function setLastPackageDigestDate(date) {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify({ lastRunDate: date }, null, 2));
}

/** Compose the pickup list for TODAY (local). Returns { count, text }. */
export async function composePackageDigest({ now = new Date(), tz = PACKAGE_DIGEST.tz } = {}) {
  const today = localNow(now, tz).date;
  const all = await listDeliveredPickups();
  const todays = all.filter((p) => localDateOf(p.deliveredAt, tz) === today);
  if (!todays.length) return { count: 0, text: "" };
  const lines = todays.map((p) => {
    const who = p.owner ? `${cap(p.owner)}: ` : "";
    const loc = p.location ? ` @ ${p.location}` : "";
    const tn = p.trackingNumber ? ` ${p.trackingNumber}` : "";
    return `- ${who}${p.description || "Package"} (${p.carrier}${tn})${loc}`;
  });
  const text = `Ready to pick up at the UPS Store (Foothill) - delivered today:\n${lines.join("\n")}`;
  return { count: todays.length, text };
}

/**
 * Compose + deliver to the owner via iMessage ONLY (per request - not Twilio
 * SMS). Sends nothing when nothing was delivered today (no daily "nothing to pick
 * up" noise). Channel injectable for tests.
 */
export async function runPackageDigest({ notify = notifyOwnerImessage, now = new Date(), cfg = PACKAGE_DIGEST } = {}) {
  const d = await composePackageDigest({ now, tz: cfg.tz });
  if (!d.count) return { count: 0, sent: false };
  await notify(d.text);
  return { count: d.count, sent: true };
}
