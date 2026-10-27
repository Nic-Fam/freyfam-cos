import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { FAMILY_PEOPLE, OWNER_EMAIL, VOICE } from "./config.js";

// ===========================================================================
// Short-term conversational memory. Each inbound message used to be handled in
// isolation, so a follow-up ("Nic's", after Lloyd asked "whose haircut?") had no
// context. This keeps a small rolling window of recent turns PER SENDER so the
// chief sees the immediately preceding exchange.
//
// Distinct from the long-term brain (memory.js): that is durable facts retrieved
// by relevance; this is the verbatim last-few-turns of THIS conversation, scoped
// by channel+sender and expired after a short idle gap so a stale thread from
// yesterday never bleeds into today. Persisted to JSON so a daemon restart
// mid-conversation doesn't wipe the thread.
// ===========================================================================

// 2026-10-26: the window was 45 minutes, after which the whole thread was deleted,
// so anything said "this morning" was gone by lunch. Now a thread lives for 72
// hours of quiet. The newest MAX_MESSAGES turns are kept verbatim; older turns are
// kept as compact dated lines (`earlier`) so Lloyd still sees what was said
// yesterday without replaying it all. Durable facts are distilled into long-term
// memory by the consolidation pass (memory-consolidate.js) before a thread expires.
const STORE_PATH = process.env.CONVO_PATH || "./data/conversations.json";
const MAX_MESSAGES = Number(process.env.CONVO_MAX_MESSAGES ?? 12); // ~6 exchanges verbatim
const IDLE_TTL_MS = Number(process.env.CONVO_IDLE_TTL_MS ?? 72 * 60 * 60 * 1000); // 72h
const MAX_EARLIER = Number(process.env.CONVO_MAX_EARLIER ?? 40);
const EARLIER_CHARS = 600;

/** Stable per-conversation key: channel + sender, lowercased. */
export function conversationKey({ channel, from } = {}) {
  return `${channel || "sms"}:${String(from || "unknown").toLowerCase().trim()}`;
}

// --- one thread per PERSON, across channels -----------------------------------
// Nic on email, Slack and iMessage used to be three unrelated conversations. A
// sender is mapped to a family member by email (FAMILY_PEOPLE) or by an extra
// handle (FAMILY_HANDLES_JSON: phone numbers, Apple IDs, Slack user ids), e.g.
//   FAMILY_HANDLES_JSON='{"nic":["+18185550101","U0123NIC"],"shelli":["+18185550102"]}'
const last10 = (s) => String(s || "").replace(/\D/g, "").slice(-10);
const HANDLES = (() => {
  let extra = {};
  try { extra = JSON.parse(process.env.FAMILY_HANDLES_JSON || "{}") || {}; } catch { extra = {}; }
  const out = {};
  for (const [person, addrs] of Object.entries(FAMILY_PEOPLE)) out[person] = [...(addrs || [])];
  for (const [person, hs] of Object.entries(extra)) out[person] = [...(out[person] || []), ...(Array.isArray(hs) ? hs : [])];
  return out;
})();

/** Which family member sent this? Returns "nic" / "shelli" / ... or null. Pure. */
export function personFor({ channel, from } = {}, handles = HANDLES) {
  const raw = String(channel === "voice" ? VOICE.from : from || "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const digits = last10(raw);
  for (const [person, hs] of Object.entries(handles)) {
    for (const h of hs) {
      const hl = String(h).toLowerCase().trim();
      if (!hl) continue;
      if (hl === lower || h === raw) return person;
      if (digits.length === 10 && /\d/.test(hl) && !hl.includes("@") && last10(hl) === digits) return person;
    }
  }
  return null;
}

/** Thread key for a message: the person's shared thread when known, else channel+sender. */
export function threadKeyFor(msg = {}) {
  const person = personFor(msg);
  return person ? `person:${person}` : conversationKey(msg);
}

/** The owner's thread (where notifyOwner messages land). */
export function ownerThreadKey() {
  const person = personFor({ channel: "email", from: OWNER_EMAIL });
  return person ? `person:${person}` : conversationKey({ channel: "email", from: OWNER_EMAIL });
}

// Fold a thread's recent turns into a single specialist task string. The delegate
// seam is text-only ({agent,task} -> text), so when a per-agent channel talks
// straight to a specialist, prior turns ride along as a labeled preamble rather
// than as separate messages -- enough to keep context across a back-and-forth.
// Empty history -> the task is returned unchanged.
export function foldThread(history, text) {
  if (!Array.isArray(history) || !history.length) return text;
  const transcript = history
    .map((m) => `${m.role === "assistant" ? "You" : "User"}: ${m.content}`)
    .join("\n");
  return `Recent conversation in this channel:\n${transcript}\n\nUser's latest message: ${text}`;
}

async function load() {
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8"));
  } catch {
    return {};
  }
}
async function save(db) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(db, null, 2));
}

/**
 * Recent turns for a key as Claude `messages` ({role, content} strings), or []
 * when there is no live thread (none yet, or the last turn is older than the
 * idle TTL -> treat as a fresh conversation).
 */
export async function getHistory(key, now = Date.now()) {
  return (await getThread(key, now)).messages;
}

/**
 * The whole live thread: `messages` (newest turns, verbatim) and `earlier`
 * (older turns as compact dated lines, oldest first). Both empty when stale.
 */
export async function getThread(key, now = Date.now()) {
  const db = await load();
  const e = db[key];
  if (!e || now - (e.updatedAt || 0) > IDLE_TTL_MS) return { messages: [], earlier: [] };
  return {
    messages: Array.isArray(e.messages) ? e.messages : [],
    earlier: Array.isArray(e.earlier) ? e.earlier : [],
  };
}

function push(db, key, entries, now) {
  const fresh = !db[key] || now - (db[key].updatedAt || 0) > IDLE_TTL_MS;
  const prev = fresh ? { messages: [], earlier: [] } : db[key];
  const messages = [...(Array.isArray(prev.messages) ? prev.messages : []), ...entries];
  const overflow = messages.length > MAX_MESSAGES ? messages.slice(0, messages.length - MAX_MESSAGES) : [];
  const earlier = [
    ...(Array.isArray(prev.earlier) ? prev.earlier : []),
    ...overflow.map((m) => ({ role: m.role, ts: m.ts, text: String(m.content || "").slice(0, EARLIER_CHARS) })),
  ].slice(-MAX_EARLIER);
  db[key] = {
    ...(fresh ? {} : prev),
    updatedAt: now,
    messages: messages.slice(-MAX_MESSAGES),
    earlier,
  };
  for (const k of Object.keys(db)) {
    if (now - (db[k].updatedAt || 0) > IDLE_TTL_MS) delete db[k]; // prune stale threads
  }
}

/**
 * Record one exchange (user text + assistant reply) onto a key's thread, trim to
 * the window, and prune any other threads that have gone stale (keeps the file
 * small). A blank reply is not recorded.
 */
export async function appendTurn(key, userText, assistantText, now = Date.now()) {
  const reply = String(assistantText || "").trim();
  if (!reply) return;
  const db = await load();
  // Stamp each turn with when it was said so the chief can anchor relative time words
  // ("tonight", "tomorrow") in an OLD turn to when they were uttered, not to now.
  push(db, key, [
    { role: "user", content: String(userText || "").trim() || "(no text)", ts: now },
    { role: "assistant", content: reply, ts: now },
  ], now);
  await save(db);
}

/**
 * Record something Lloyd SENT on his own (the morning digest, a proactive
 * heads-up, an approval request, a background result) into the recipient's
 * thread, so a reply like "yes, do that" or "done 2" has something to refer to.
 * `kind` is a short label shown to the model ("morning digest", "heads-up").
 * Best-effort: never throws.
 */
export async function recordOutbound(key, text, { kind = "message", now = Date.now() } = {}) {
  const body = String(text || "").trim();
  if (!key || !body) return;
  try {
    const db = await load();
    push(db, key, [{ role: "assistant", content: `[Lloyd sent a ${kind}] ${body}`.slice(0, 4000), ts: now, outbound: true }], now);
    await save(db);
  } catch {
    /* history is a nicety; never break a send over it */
  }
}

/** Mark a thread consolidated through `ts` (memory-consolidate.js). */
export async function markConsolidated(key, ts) {
  const db = await load();
  if (!db[key]) return;
  db[key].consolidatedThrough = ts;
  await save(db);
}

/** All live threads, for the consolidation pass. */
export async function listThreads(now = Date.now()) {
  const db = await load();
  return Object.entries(db)
    .filter(([, e]) => e && now - (e.updatedAt || 0) <= IDLE_TTL_MS)
    .map(([key, e]) => ({ key, ...e }));
}
