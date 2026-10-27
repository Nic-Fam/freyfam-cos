import { complete, systemBlocks, textOf, parseJson } from "./claude.js";
import { MODELS } from "./config.js";
import { listThreads, markConsolidated } from "./conversation.js";
import { rememberFact } from "./memory.js";
import { delegate } from "./delegate.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Long-term memory consolidation (2026-10-26).
//
// Memories used to form only when Lloyd remembered to call `remember` mid-turn,
// and he was told to save "durable facts and preferences", so events, decisions
// and outcomes ("we toured Fairview and liked it", "the plumber quoted $1,800")
// were never kept, and the conversation that held them was deleted after 45
// minutes. Now, once a thread has been quiet for a while, ONE cheap call (the
// triage tier, Haiku) reads the turns since the last pass and extracts what is
// worth keeping. Each memory is saved with duplicate detection and can retire an
// older fact it replaces (memory.rememberFact). A specialist's fact is written to
// THAT specialist's own store over the delegate seam, wherever it runs.
//
// Cost: one small call per quiet thread with new content, typically a few per day.
// ===========================================================================

const log = createLogger("memory-consolidate");

const IDLE_MS = Number(process.env.MEMORY_CONSOLIDATE_IDLE_MS ?? 2 * 60 * 60 * 1000); // 2h quiet
const MAX_THREADS_PER_TICK = 3;
const AGENTS = new Set(["finance", "dev", "resale", "chef", "security"]);

const SYSTEM = `You maintain the long-term memory of a family's chief of staff (Lloyd).
You are given recent conversation turns between the family and Lloyd, plus today's
date. Extract ONLY what will still matter in a week or more:
- facts and preferences ("Fox is allergic to tree nuts", "Shelli prefers aisle seats")
- decisions and their reasons ("Decided not to bid on 1205 Geneva St: too small")
- outcomes of events ("On Oct 27 Nic and Shelli toured 500 Fairview Ave and liked it")
- commitments with dates ("Plumber (Joe's Plumbing) comes back Nov 3 to replace the valve")
- changes to something known before (then fill "supersedes" with the old fact)

Do NOT extract: small talk, requests that were simply done and have no lasting effect,
task-list housekeeping ("done 2"), the morning digest's routine contents, passwords,
codes, account numbers, or anything Lloyd only guessed.

Write each memory as ONE self-contained sentence with names and ABSOLUTE dates (turn
"tomorrow" into the real date using the timestamps). Set "agent" when the fact belongs
to one specialist's beat: finance (money, bills, accounts), chef (meals, food,
allergies, kitchen), resale (buying/selling items, hunts), security (accounts,
devices, home security), dev (software, devices to build/fix); otherwise null.

Respond with ONLY JSON, no prose:
{"memories":[{"text":string,"agent":null|"finance"|"chef"|"resale"|"security"|"dev","supersedes":null|string}]}
Return {"memories":[]} when nothing qualifies. At most 6.`;

/** New turns since the last consolidation, oldest first, skipping Lloyd's broadcasts. Pure. */
export function newTurns(thread) {
  const since = Number(thread?.consolidatedThrough || 0);
  const all = [
    ...(thread?.earlier || []).map((e) => ({ role: e.role, ts: e.ts, text: e.text })),
    ...(thread?.messages || []).map((m) => ({ role: m.role, ts: m.ts, text: m.content, outbound: m.outbound })),
  ];
  return all
    .filter((t) => Number(t.ts || 0) > since && typeof t.text === "string" && t.text.trim())
    .filter((t) => !/^\[Lloyd sent a morning digest\]/.test(t.text))
    .sort((a, b) => a.ts - b.ts);
}

function transcript(turns, tz = process.env.FAMILY_TZ || "America/Los_Angeles") {
  const fmt = (ts) => new Date(ts).toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  return turns.map((t) => `[${fmt(t.ts)}] ${t.role === "assistant" ? "Lloyd" : "Family"}: ${t.text.slice(0, 1500)}`).join("\n");
}

/** Validate the model's JSON into a clean list. Pure. */
export function parseMemories(parsed) {
  const list = Array.isArray(parsed?.memories) ? parsed.memories : [];
  return list
    .filter((m) => m && typeof m.text === "string" && m.text.trim().length >= 12)
    .slice(0, 6)
    .map((m) => ({
      text: m.text.trim().slice(0, 400),
      agent: AGENTS.has(m.agent) ? m.agent : null,
      supersedes: typeof m.supersedes === "string" && m.supersedes.trim() ? m.supersedes.trim().slice(0, 200) : null,
    }));
}

/**
 * Consolidate one thread. Returns {saved, skipped}. Injectable for tests:
 * `llm` (complete), `save` (household fact), `saveFor` (specialist fact).
 */
export async function consolidateThread(thread, {
  now = Date.now(),
  llm = complete,
  save = (m) => rememberFact(m.text, { supersedes: m.supersedes, source: "conversation" }),
  saveFor = async (m) => {
    const r = await delegate({ agent: m.agent, op: "remember", args: { text: m.text, supersedes: m.supersedes } });
    if (r?.error) throw new Error(r.error);
    return r?.data;
  },
  mark = markConsolidated,
} = {}) {
  const turns = newTurns(thread);
  const lastTs = turns.length ? turns[turns.length - 1].ts : null;
  // Nothing the family said -> nothing to learn. Mark and move on, no model call.
  if (!turns.some((t) => t.role === "user" && t.text.split(/\s+/).length >= 3)) {
    if (lastTs) await mark(thread.key, lastTs);
    return { saved: [], skipped: "no substantive family turns" };
  }
  const today = new Date(now).toISOString().slice(0, 10);
  const resp = await llm({
    model: MODELS.triage,
    system: systemBlocks(SYSTEM),
    messages: [{ role: "user", content: `Today is ${today}.\n\nConversation:\n${transcript(turns)}` }],
    maxTokens: 2048,
  });
  const memories = parseMemories(parseJson(textOf(resp)));
  const saved = [];
  for (const m of memories) {
    try {
      const r = m.agent ? await saveFor(m) : await save(m);
      if (r?.saved !== false) saved.push(m);
    } catch (e) {
      log.warn("could not save consolidated memory", { agent: m.agent, reason: String(e?.message || e) });
    }
  }
  await mark(thread.key, lastTs);
  if (saved.length) log.info("consolidated thread into memory", { thread: thread.key, saved: saved.length });
  return { saved };
}

/** Heartbeat entry: consolidate up to a few threads that have gone quiet. */
export async function consolidateIdleThreads({ now = Date.now(), threads = listThreads, consolidate = consolidateThread } = {}) {
  const live = await threads(now);
  const due = live
    .filter((t) => now - (t.updatedAt || 0) >= IDLE_MS && newTurns(t).length > 0)
    .slice(0, MAX_THREADS_PER_TICK);
  const results = [];
  for (const t of due) {
    try {
      results.push(await consolidate(t, { now }));
    } catch (e) {
      log.warn("thread consolidation failed; will retry next tick", { thread: t.key, reason: String(e?.message || e) });
    }
  }
  return results;
}
