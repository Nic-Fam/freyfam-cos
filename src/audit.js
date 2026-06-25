import { randomUUID } from "node:crypto";
import { createCollection } from "./stores/collection.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Action audit log. An agent that acts on the family's behalf should be able to
// answer "what did you actually do?" Every OUTBOUND / side-effectful action (email
// sent, calendar event created, order placed, list item added) appends one line
// here. Read-only summary surfaced via the chief's `recent_actions` tool. Builds
// trust + is the paper trail if something looks off. Best-effort: logging never
// blocks or breaks the action it records.
// ===========================================================================

const log = createLogger("audit");
const col = () => createCollection({ file: process.env.AUDIT_PATH || "./data/audit-log.json", partition: "audit" });

/**
 * Record an action. `kind` is a short verb-ish label ("email", "calendar",
 * "order", "list"); `summary` is a one-line human description (keep it to who/what,
 * no secrets). Best-effort — never throws.
 */
export async function logAction(kind, summary, { now = () => new Date().toISOString() } = {}) {
  try {
    await col().add({ id: randomUUID().slice(0, 8), kind: String(kind || "action"), summary: String(summary || "").slice(0, 300), at: now() });
  } catch (err) {
    log.warn("audit write failed (non-fatal)", { reason: String(err?.message || err) });
  }
}

/** Actions in the last `sinceDays`, newest first. */
export async function listActions({ sinceDays = 7 } = {}) {
  let items = [];
  try { items = await col().list(); } catch { items = []; }
  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  return items
    .filter((a) => a && a.at && Date.parse(a.at) >= cutoff)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** Human summary grouped by kind. Pure. */
export function formatAudit(actions = [], { tz = process.env.FAMILY_TZ || "America/Los_Angeles" } = {}) {
  if (!actions.length) return "No recorded actions in that window.";
  const when = (iso) => {
    try { return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso)); }
    catch { return iso; }
  };
  return actions.map((a) => `- [${when(a.at)}] ${a.kind}: ${a.summary}`).join("\n");
}
