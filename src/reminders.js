import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ===========================================================================
// Reminders (ported from the legacy assistant, simplified to the COS local
// store). A reminder fires at fireAt (ISO instant); the heartbeat checks for due
// ones each tick and notifies the owner. Recurring reminders re-arm to their
// next occurrence; one-shots are marked fired. Persisted, so a restart never
// drops a pending reminder.
// ===========================================================================

const STORE_PATH = () => process.env.REMINDERS_PATH || "./data/reminders.json";

async function load() {
  try {
    const d = JSON.parse(await readFile(STORE_PATH(), "utf8"));
    return Array.isArray(d.items) ? d : { items: [] };
  } catch {
    return { items: [] };
  }
}
async function save(db) {
  await mkdir(dirname(STORE_PATH()), { recursive: true });
  await writeFile(STORE_PATH(), JSON.stringify(db, null, 2));
}

const RECURRENCES = new Set(["daily", "weekdays", "weekly"]);

/** Next fire instant for a recurrence, or null for a one-shot. Pure. DST-safe via local-day math. */
export function nextOccurrence(fireAtIso, recurrence) {
  if (!RECURRENCES.has(recurrence)) return null;
  const d = new Date(fireAtIso);
  if (Number.isNaN(d.getTime())) return null;
  const add = (days) => new Date(d.getTime() + days * 86400000);
  if (recurrence === "daily") return add(1).toISOString();
  if (recurrence === "weekly") return add(7).toISOString();
  if (recurrence === "weekdays") {
    let next = add(1);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next = new Date(next.getTime() + 86400000);
    return next.toISOString();
  }
  return null;
}

/**
 * Create a reminder. fireAt is an ISO instant; recurrence is daily|weekdays|weekly
 * or omitted for one-shot. Deduped on (message, fireAt) among unfired reminders so
 * a repeated "YES" can't double-arm. Returns { reminder, deduped }.
 */
export async function createReminder({ message, fireAt, recurrence = null } = {}, now = Date.now()) {
  const msg = String(message || "").trim();
  if (!msg) throw new Error("reminder message is required");
  if (!fireAt || Number.isNaN(new Date(fireAt).getTime())) throw new Error("reminder fireAt must be a valid ISO datetime");
  const db = await load();
  const dup = db.items.find((r) => !r.fired && r.message === msg && r.fireAt === fireAt);
  if (dup) return { reminder: dup, deduped: true };
  const reminder = {
    id: randomUUID().slice(0, 8),
    message: msg,
    fireAt: new Date(fireAt).toISOString(),
    recurrence: RECURRENCES.has(recurrence) ? recurrence : null,
    fired: false,
    createdAt: new Date(now).toISOString(),
  };
  db.items.push(reminder);
  await save(db);
  return { reminder, deduped: false };
}

/** Unfired reminders whose fireAt is at/before now. */
export async function getDueReminders(now = new Date()) {
  const db = await load();
  const t = now.getTime();
  return db.items.filter((r) => !r.fired && new Date(r.fireAt).getTime() <= t);
}

/** After firing: re-arm a recurring reminder to its next occurrence, else mark fired. */
export async function afterFired(id) {
  const db = await load();
  const r = db.items.find((x) => x.id === id);
  if (!r) return;
  const next = r.recurrence ? nextOccurrence(r.fireAt, r.recurrence) : null;
  if (next) { r.fireAt = next; r.fired = false; }
  else { r.fired = true; r.firedAt = new Date().toISOString(); }
  await save(db);
}

/** Cancel a reminder by id/prefix. Returns the removed reminder or null. */
export async function cancelReminder(match) {
  const db = await load();
  const m = String(match || "").trim();
  const r = db.items.find((x) => x.id === m) || db.items.find((x) => x.id.startsWith(m) && m.length >= 4);
  if (!r) return null;
  db.items = db.items.filter((x) => x.id !== r.id);
  await save(db);
  return r;
}

/** Pending (unfired) reminders, soonest first. */
export async function listReminders() {
  const db = await load();
  return db.items.filter((r) => !r.fired).sort((a, b) => a.fireAt.localeCompare(b.fireAt));
}
