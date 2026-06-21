import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// House rules = always-on operating policy, distinct from RAG memory. A fact you
// ASK about is fine to retrieve by recall; a RULE must apply every time it's
// relevant, not only when your wording happens to match it. So rules are injected
// into EVERY chief turn's context (see orchestrator.runChief), never left to the
// top-k recall lottery. This mirrors how the old assistant carried rules in its
// system prompt.
//
// Stored in data/house-rules.json (gitignored — may contain family specifics like
// work emails). See data/house-rules.example.json for the shape. Edit the JSON and
// restart the daemon to change the rules.
// ===========================================================================

const RULES_PATH = process.env.HOUSE_RULES_PATH || "./data/house-rules.json";

/** Return the house rules as a string array (empty if none / unreadable). */
export async function getHouseRules() {
  try {
    const data = JSON.parse(await readFile(RULES_PATH, "utf8"));
    const rules = Array.isArray(data?.rules) ? data.rules : [];
    return rules.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim());
  } catch {
    return [];
  }
}

/** Render rules for the system context. Empty string when there are none. */
export function formatHouseRules(rules) {
  if (!rules || !rules.length) return "";
  return "House rules (always apply; use the current time above to judge conditions like 'during the workday'):\n" +
    rules.map((r) => "- " + r).join("\n");
}

// ---------------------------------------------------------------------------
// Per-agent rules. Same always-on argument as the house rules, but scoped to one
// specialist's beat (e.g. chef: "never plan a meal with nuts"; security: "never
// advise disarming without confirmation"). They live under an optional
// `agentRules` map in the SAME house-rules.json, so the family adds local/secret
// per-agent policy without editing the persona source. Injected in runSpecialist.
// ---------------------------------------------------------------------------

/** Return the always-on rules for one agent (empty if none / unreadable). */
export async function getAgentRules(agent) {
  try {
    const data = JSON.parse(await readFile(RULES_PATH, "utf8"));
    const rules = Array.isArray(data?.agentRules?.[agent]) ? data.agentRules[agent] : [];
    return rules.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim());
  } catch {
    return [];
  }
}

/** Render an agent's rules for its system context. Empty string when none. */
export function formatAgentRules(rules) {
  if (!rules || !rules.length) return "";
  return "Your standing rules (always apply on your beat):\n" + rules.map((r) => "- " + r).join("\n");
}

// ---------------------------------------------------------------------------
// Writers. The family adds rules over time by just messaging Lloyd; he calls the
// add_rule / remove_rule / list_rules tools (orchestrator.js), which call these.
// getHouseRules()/getAgentRules() re-read the file on every turn, so a written
// rule applies on the NEXT message with no daemon restart. The JSON stays the
// single source of truth, so hand-editing the file still works too.
// ---------------------------------------------------------------------------

// Valid agentRules keys, so a typo ("chiff") can't create a dead rule no agent reads.
export const KNOWN_AGENTS = ["chief", "finance", "dev", "resale", "chef", "security"];

async function loadRaw() {
  try {
    const data = JSON.parse(await readFile(RULES_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
async function saveRaw(data) {
  await mkdir(dirname(RULES_PATH), { recursive: true });
  await writeFile(RULES_PATH, JSON.stringify(data, null, 2));
}

/**
 * Add a standing rule. Omit `agent` for a house rule (chief); pass one of
 * KNOWN_AGENTS for a per-agent rule. Idempotent on exact text. Preserves all
 * other keys in the file. Returns { added, scope, text }.
 */
export async function addRule(text, { agent } = {}) {
  const t = String(text || "").trim();
  if (!t) throw new Error("rule text is required");
  if (agent && !KNOWN_AGENTS.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (expected one of: ${KNOWN_AGENTS.join(", ")})`);
  }
  const data = await loadRaw();
  if (agent) {
    data.agentRules = data.agentRules && typeof data.agentRules === "object" ? data.agentRules : {};
    const list = Array.isArray(data.agentRules[agent]) ? data.agentRules[agent] : [];
    if (list.includes(t)) return { added: false, scope: agent, text: t };
    list.push(t);
    data.agentRules[agent] = list;
  } else {
    const list = Array.isArray(data.rules) ? data.rules : [];
    if (list.includes(t)) return { added: false, scope: "house", text: t };
    list.push(t);
    data.rules = list;
  }
  await saveRaw(data);
  return { added: true, scope: agent || "house", text: t };
}

/**
 * Remove a standing rule by exact text OR 1-based index (as shown by list).
 * Omit `agent` for a house rule. Returns the removed text, or null if no match.
 */
export async function removeRule(match, { agent } = {}) {
  if (agent && !KNOWN_AGENTS.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (expected one of: ${KNOWN_AGENTS.join(", ")})`);
  }
  const data = await loadRaw();
  const list = agent
    ? (Array.isArray(data.agentRules?.[agent]) ? data.agentRules[agent] : [])
    : (Array.isArray(data.rules) ? data.rules : []);
  if (!list.length) return null;

  let idx = -1;
  const asNum = Number(match);
  if (Number.isInteger(asNum) && asNum >= 1 && asNum <= list.length) idx = asNum - 1;
  else idx = list.findIndex((r) => r === String(match || "").trim());
  if (idx < 0) return null;

  const [removed] = list.splice(idx, 1);
  if (agent) data.agentRules[agent] = list;
  else data.rules = list;
  await saveRaw(data);
  return removed;
}
