import { createLogger } from "./log.js";

// ===========================================================================
// Liveness heartbeat to the cloud (workstream R, item 1 — the dead-man's-switch).
//
// The daemon upserts a {lastSeen} row to an Azure Table every heartbeat tick (and
// on boot). An OFF-Mac monitor (an Azure timer Function — see the front-door repo's
// liveness-monitor) reads this row and alerts the family over a WORKING channel
// (email) if Lloyd goes silent — i.e. a local power/hardware outage. This is the one
// alarm that does NOT depend on Lloyd being up (every other alert routes through him
// or the dead Twilio number), so it must stay dead simple and never throw.
//
// Privacy: the row carries ONLY liveness metadata (timestamp, host, pid) — never any
// family content. Same storage account as the inbound queue, so no new config.
// ===========================================================================

const log = createLogger("liveness");

const CONN = () => process.env.LIVENESS_CONNECTION_STRING || process.env.AZURE_STORAGE_CONNECTION_STRING;
const TABLE = process.env.LIVENESS_TABLE || "cosliveness";
export const LIVENESS_PARTITION = "liveness";
export const LIVENESS_ROW = process.env.LIVENESS_ROW || "lloyd";

let _client; // memoized TableClient (null = unavailable / no creds)

async function client() {
  if (_client !== undefined) return _client;
  const cs = CONN();
  if (!cs) {
    _client = null;
    return null;
  }
  try {
    const { TableClient } = await import("@azure/data-tables");
    const c = TableClient.fromConnectionString(cs, TABLE);
    try { await c.createTable(); } catch { /* table already exists -> fine */ }
    _client = c;
  } catch (err) {
    log.warn("liveness table client unavailable (non-fatal)", { reason: String(err?.message || err) });
    _client = null;
  }
  return _client;
}

/** The liveness entity written each tick. Pure (exported for tests). */
export function livenessEntity({ now = new Date(), host = "", pid = 0 } = {}) {
  return {
    partitionKey: LIVENESS_PARTITION,
    rowKey: LIVENESS_ROW,
    lastSeen: now.toISOString(),
    host: String(host || "").slice(0, 100),
    pid: Number(pid) || 0,
  };
}

/** Age of a lastSeen timestamp in ms. Pure; the monitor mirrors this logic. */
export function stalenessMs(lastSeenIso, now = new Date()) {
  const t = Date.parse(lastSeenIso);
  if (Number.isNaN(t)) return Infinity;
  return now.getTime() - t;
}

/**
 * Upsert the liveness row. BEST-EFFORT: returns true on success, false on any
 * failure or when no storage is configured. Never throws — a cloud write hiccup
 * must not disturb the heartbeat.
 */
export async function recordLiveness({ now = new Date() } = {}) {
  try {
    const c = await client();
    if (!c) return false;
    const os = await import("node:os");
    await c.upsertEntity(livenessEntity({ now, host: os.hostname(), pid: process.pid }), "Replace");
    return true;
  } catch (err) {
    log.warn("liveness write failed (non-fatal)", { reason: String(err?.message || err) });
    return false;
  }
}
