import { agentLoop, systemBlocks } from "../claude.js";
import { modelForAgent } from "../config.js";
import { recall } from "../memory.js";
import { persona } from "../persona.js";
import { specialistTools } from "../agents/tools.js";
import { getAgentRules, formatAgentRules } from "../rules.js";
import { createLogger } from "../log.js";

const log = createLogger("specialist");

// Local-time line so a specialist's time-conditional rules work, mirroring the
// chief. Kept inline (not imported from orchestrator) to avoid a circular import
// via delegate -> runner.
const FAMILY_TZ = process.env.FAMILY_TZ || "America/Los_Angeles";
function nowLocal(now = new Date()) {
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: FAMILY_TZ, weekday: "long", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(now);
  return `${s} (${FAMILY_TZ})`;
}

// ===========================================================================
// The specialist execution CORE. This is deliberately transport-agnostic: it
// is a pure function of (agent, task) + the stores it reads, with NO knowledge
// of how it was invoked. Today Lloyd calls it in-process (see delegate.js);
// after the Azure split this same module is what each specialist Function runs.
//
// HARD CONSTRAINT preserved by construction: a specialist only RETURNS text and
// uses its own scoped, side-effect-light tools (recall/remember, decision log,
// domain tools). It has NO outbound channel and NO confirmation power - those
// live exclusively on Lloyd. So running this here vs. in Azure cannot change
// what the specialist is allowed to do.
// ===========================================================================

export async function runSpecialist(agent, task, { images } = {}) {
  const p = await persona(agent);
  const mems = await recall(task, 4, { agent });
  // Always-on, scoped policy beats the recall lottery (same argument as the
  // chief's house rules). Order: time, then standing rules, then recalled facts.
  const rules = await getAgentRules(agent);
  const ctx = [
    `Now: ${nowLocal()}`,
    formatAgentRules(rules),
    mems.length ? `Relevant memory:\n${mems.map((m) => "- " + m.text).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  const { tools: specTools, handlers: rawHandlers } = specialistTools(agent);
  // Trace each tool call so a runaway loop (the one that ends in "max tool turns
  // reached") is visible: we log the tool name before invoking it, and any failure.
  // Names only, never inputs/results, so nothing sensitive is logged.
  const specHandlers = {};
  for (const [name, fn] of Object.entries(rawHandlers)) {
    specHandlers[name] = async (input) => {
      log.info("tool call", { agent, tool: name });
      try {
        return await fn(input);
      } catch (e) {
        log.warn("tool call failed", { agent, tool: name, error: String(e?.message || e) });
        throw e;
      }
    };
  }
  // When the inbound turn carried photos (MMS), the chief forwards the same image
  // blocks so the specialist sees the actual picture (Shey an item, Carmine a
  // receipt), not just Lloyd's description. Plain text task otherwise.
  const content = images?.length ? [{ type: "text", text: task }, ...images] : task;
  const { text } = await agentLoop({
    // Per-agent tier (cost lever): low-stakes specialists (resale, chef) run on
    // Haiku; finance/dev/security stay on Sonnet. See config.SPECIALIST_TIERS.
    model: modelForAgent(agent),
    system: systemBlocks(p, ctx),
    messages: [{ role: "user", content }],
    tools: specTools,
    toolHandlers: specHandlers,
    maxTurns: 6,
  });
  return text;
}
