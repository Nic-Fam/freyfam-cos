// Per-agent decision log (the Genet "decision.md" pattern). A durable, human-
// readable record of the *final decisions* each specialist made, kept separate
// from the vector brain (memory.js): recall is for fuzzy "what do I know", this
// is the append-only audit trail of "what did I decide and why".
//
// Each agent gets two files under data/decisions/:
//   - <agent>.json  canonical structured records (what listDecisions reads)
//   - <agent>.md    a human-readable log, regenerated from the JSON on every
//                   write so it can never drift from the source of truth.
//
// Storage is pluggable (src/stores/collection.js): a local JSON file by default,
// or this specialist's Azure Table when COS_TABLE_* is set (remote on a Function).
// The human-readable <agent>.md is a LOCAL nicety only - it is regenerated on each
// write in JSON mode and skipped in Table mode (a Function filesystem is ephemeral).

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCollection, usingTableStore } from "./stores/collection.js";

const DIR = () => process.env.DECISIONS_DIR || "./data/decisions";

// Keep agent keys to a safe filename charset so an agent value can never escape
// the decisions directory.
function safeAgent(agent) {
  const a = String(agent || "").trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(a)) throw new Error(`invalid agent key: ${JSON.stringify(agent)}`);
  return a;
}

// One collection per agent. Local: data/decisions/<agent>.json. Remote: the
// "decision" partition of this specialist's table (memory uses a different one).
function collection(agent) {
  return createCollection({ file: join(DIR(), `${agent}.json`), partition: "decision" });
}

function renderMarkdown(agent, items) {
  const lines = [`# Decision log: ${agent}`, ""];
  if (!items.length) {
    lines.push("_No decisions recorded yet._", "");
    return lines.join("\n");
  }
  // Newest first so the latest decision is at the top of the human-readable file.
  for (const it of [...items].reverse()) {
    lines.push(`## ${it.createdAt} — ${it.title}`, "");
    lines.push(it.decision, "");
    if (it.rationale) lines.push(`**Why:** ${it.rationale}`, "");
    if (it.context) lines.push(`**Context:** ${it.context}`, "");
    lines.push(`<sub>id: ${it.id}</sub>`, "");
  }
  return lines.join("\n");
}

/**
 * Record a final decision for an agent. Append-only.
 * @param {string} agent role key (chief-of-staff, finance, dev, resale, chef, security)
 * @param {{title:string, decision:string, rationale?:string, context?:string}} input
 */
export async function logDecision(agent, { title, decision, rationale = "", context = "" } = {}) {
  const key = safeAgent(agent);
  if (!title || !String(title).trim()) throw new Error("title is required");
  if (!decision || !String(decision).trim()) throw new Error("decision is required");
  const col = collection(key);
  const item = {
    id: randomUUID().slice(0, 8),
    title: String(title).trim(),
    decision: String(decision).trim(),
    rationale: String(rationale || "").trim(),
    context: String(context || "").trim(),
    createdAt: new Date().toISOString(),
  };
  await col.add(item);
  if (!usingTableStore()) {
    // Regenerate the human-readable log beside the JSON (local only).
    await mkdir(DIR(), { recursive: true });
    await writeFile(join(DIR(), `${key}.md`), renderMarkdown(key, await col.list()));
  }
  return item;
}

/** List an agent's recorded decisions, newest first. */
export async function listDecisions(agent, limit = 20) {
  const items = await collection(safeAgent(agent)).list();
  return [...items].reverse().slice(0, limit);
}
