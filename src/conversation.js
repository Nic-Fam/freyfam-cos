import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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

const STORE_PATH = process.env.CONVO_PATH || "./data/conversations.json";
const MAX_MESSAGES = Number(process.env.CONVO_MAX_MESSAGES ?? 12); // ~6 exchanges
const IDLE_TTL_MS = Number(process.env.CONVO_IDLE_TTL_MS ?? 45 * 60 * 1000); // 45 min

/** Stable per-conversation key: channel + sender, lowercased. */
export function conversationKey({ channel, from } = {}) {
  return `${channel || "sms"}:${String(from || "unknown").toLowerCase().trim()}`;
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
  const db = await load();
  const e = db[key];
  if (!e || now - (e.updatedAt || 0) > IDLE_TTL_MS) return [];
  return Array.isArray(e.messages) ? e.messages : [];
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
  const fresh = !db[key] || now - (db[key].updatedAt || 0) > IDLE_TTL_MS;
  const messages = fresh ? [] : (Array.isArray(db[key].messages) ? db[key].messages : []);
  messages.push({ role: "user", content: String(userText || "").trim() || "(no text)" });
  messages.push({ role: "assistant", content: reply });
  db[key] = { updatedAt: now, messages: messages.slice(-MAX_MESSAGES) };
  for (const k of Object.keys(db)) {
    if (now - (db[k].updatedAt || 0) > IDLE_TTL_MS) delete db[k]; // prune stale threads
  }
  await save(db);
}
