import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// Scheduler for Shey's saved-search runs, so new listings surface on their own
// (the "RSS feed" behavior). TheRealReal posts new items at 7am and 4pm Pacific
// daily, so we run immediately AFTER each post. Twice-daily slots, once per slot
// per local day, with a persisted guard so a daemon restart can't re-fire. The
// heartbeat calls this; the run itself delegates to resale (Shey) and notifies
// the family of new finds.
// ===========================================================================

const TZ = process.env.FAMILY_TZ || "America/Los_Angeles";
const STATE_PATH = () => process.env.RESALE_SCHED_PATH || "./data/resale-schedule.json";
const WINDOW_MIN = Number(process.env.RESALE_RUN_WINDOW_MIN ?? 55);

// Run right after TheRealReal's 7am / 4pm PT drops. Override "H:MM,H:MM".
const SLOTS = (process.env.RESALE_RUN_TIMES || "07:05,16:05")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((label) => {
    const [h, m] = label.split(":").map(Number);
    return { label, minutes: h * 60 + (m || 0) };
  });

/** {date:"YYYY-MM-DD", minutesOfDay} in the family tz. */
export function localHM(now = new Date(), tz = TZ) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return { date, minutesOfDay: h * 60 + m };
}

/**
 * Which run slots are due now (in their post-drop window and not yet run today).
 * Pure. `state` maps slot label -> last-run date. Returns { due:[{label}], date }.
 */
export function dueSlots(now, state = {}, { slots = SLOTS, windowMin = WINDOW_MIN, tz = TZ } = {}) {
  const { date, minutesOfDay } = localHM(now, tz);
  const due = [];
  for (const s of slots) {
    const inWindow = minutesOfDay >= s.minutes && minutesOfDay < s.minutes + windowMin;
    if (inWindow && state[s.label] !== date) due.push({ label: s.label });
  }
  return { due, date };
}

export async function getResaleState() {
  try {
    return JSON.parse(await readFile(STATE_PATH(), "utf8"));
  } catch {
    return {};
  }
}

export async function setSlotRan(label, date) {
  const state = await getResaleState();
  state[label] = date;
  await mkdir(dirname(STATE_PATH()), { recursive: true });
  await writeFile(STATE_PATH(), JSON.stringify(state, null, 2));
}
