import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// Proactive-alert memory. The heartbeat re-triages the same signals every tick,
// so without this it re-raises the SAME proactive heads-up (an unrecognized email,
// a flag) over and over — and a family "that's handled" reply never stuck. This
// gives the escalation loop two brakes:
//   - dedup: don't re-send the same alert within a TTL (no every-15-min spam).
//   - dismiss: once the family acknowledges an alert, suppress it FOR GOOD.
// Matching is by significant-word signature, tolerant of the LLM rephrasing the
// alert text between ticks (dismiss is fuzzy: overlap with the dismissed topic).
// ===========================================================================

const PATH = () => process.env.HEARTBEAT_ALERTS_PATH || "./data/heartbeat-alerts.json";
const DEDUP_TTL_MS = Number(process.env.HEARTBEAT_ALERT_TTL_MS ?? 24 * 60 * 60 * 1000); // 24h

// Generic/stopwords stripped before signing, so phrasing noise doesn't change the key.
const STOP = new Set(
  ("a an the this that these those to of in on at for and or but is are was were be been being it its you your we our they them he she his her i me my today tonight tomorrow now proactive fyi heads up need needs needed check checking please just about with from as no not any some there here re fwd did do does done yes ok okay it's dont don't")
    .split(/\s+/)
);

/** Significant lowercased words of an alert (drop stopwords + short tokens, unique). */
export function significantWords(text) {
  const words = String(text || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  return [...new Set(words.filter((w) => w.length > 2 && !STOP.has(w)))];
}
/** Stable exact signature (sorted significant words) for the dedup map. */
export function alertSignature(text) {
  return significantWords(text).sort().join(" ");
}

async function load() { try { return JSON.parse(await readFile(PATH(), "utf8")); } catch { return { seen: {}, dismissed: {} }; } }
async function save(db) { await mkdir(dirname(PATH()), { recursive: true }); await writeFile(PATH(), JSON.stringify(db, null, 2)); }

// Fuzzy: does `words` cover most of a dismissed topic's words? (>= 60% overlap).
function coversDismissed(words, entry, thresh = 0.6) {
  const dw = entry?.words || [];
  if (dw.length < 2) return false;
  const hit = dw.filter((w) => words.includes(w)).length / dw.length;
  return hit >= thresh;
}

/** Should this proactive alert be sent now? False if dismissed or alerted within TTL. */
export async function shouldAlert(text, { now = Date.now(), ttlMs = DEDUP_TTL_MS } = {}) {
  const words = significantWords(text);
  if (!words.length) return true;
  const db = await load();
  for (const entry of Object.values(db.dismissed || {})) if (coversDismissed(words, entry)) return false;
  const last = (db.seen || {})[alertSignature(text)];
  if (last && now - last < ttlMs) return false;
  return true;
}

/** Record that an alert was just sent (so ticks within the TTL dedup it). Prunes >30d. */
export async function recordAlerted(text, { now = Date.now() } = {}) {
  const sig = alertSignature(text);
  if (!sig) return;
  const db = await load();
  db.seen = db.seen || {};
  db.seen[sig] = now;
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  for (const k of Object.keys(db.seen)) if (db.seen[k] < cutoff) delete db.seen[k];
  await save(db);
}

/** Permanently dismiss an alert topic (family acknowledged it). Fuzzy-matched later. */
export async function dismissAlert(text, { note = null, now = Date.now() } = {}) {
  const words = significantWords(text);
  if (words.length < 2) return { ok: false, reason: "too_vague" };
  const db = await load();
  db.dismissed = db.dismissed || {};
  db.dismissed[words.slice().sort().join(" ")] = { at: now, note, words, text: String(text).slice(0, 200) };
  await save(db);
  return { ok: true, words };
}

export async function listDismissed() { return (await load()).dismissed || {}; }
