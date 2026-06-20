import { readFile } from "node:fs/promises";

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
