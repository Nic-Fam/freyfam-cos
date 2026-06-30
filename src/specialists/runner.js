import { agentLoop, systemBlocks } from "../claude.js";
import { modelForAgent } from "../config.js";
import { recall } from "../memory.js";
import { persona } from "../persona.js";
import { specialistTools } from "../agents/tools.js";
import { getAgentRules, formatAgentRules } from "../rules.js";
import { recordUsage, budgetState } from "../cost-ledger.js";
import { companyKeyForAgent } from "../companies.js";
import { createLogger } from "../log.js";

// Optional HARD cap (workstream S step 3). Off by default: the ledger is a soft,
// warn-only early warning (it alerts the owner on a budget crossing but keeps
// running). Set COS_COO_BUDGET_HARDCAP=true to make an over-budget company REFUSE
// further COO-tier runs until the cycle resets, saving spend at the cost of
// pausing the company. Either way, family specialists and the chief are unaffected.
const HARD_CAP = String(process.env.COS_COO_BUDGET_HARDCAP ?? "false").toLowerCase() === "true";

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
  // Optional hard cap: if this agent's company is already over budget for the cycle
  // and the hard cap is on, refuse the run before spending a single token. Soft
  // (default) keeps running and relies on the one-time alert in recordUsage.
  if (HARD_CAP) {
    try {
      const companyKey = companyKeyForAgent(agent);
      const b = companyKey ? await budgetState(companyKey) : null;
      if (b?.over) {
        return { text: `${agent} is paused: ${b.company} is over its ${b.cycle} budget ($${b.budgetUsd}). It resumes next cycle, or raise the budget.`, requests: [] };
      }
    } catch { /* metering must never block a run */ }
  }
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
  // Per-invocation request collector (workstream S step 2). A COO's request tools
  // push onto this; every other agent leaves it empty. It rides back in the return
  // so Lloyd can fulfill the requests behind his gate - requests never touch a
  // shared store, so this stays transport-safe when a COO later runs remotely.
  const requests = [];
  const { tools: specTools, handlers: rawHandlers } = specialistTools(agent, { requests });
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
  // Per-agent tier (cost lever): low-stakes specialists (resale, chef) run on
  // Haiku; finance/dev/security stay on Sonnet. See config.SPECIALIST_TIERS.
  const model = modelForAgent(agent);
  const { text, usage } = await agentLoop({
    model,
    system: systemBlocks(p, ctx),
    messages: [{ role: "user", content }],
    tools: specTools,
    toolHandlers: specHandlers,
    maxTurns: 6,
  });
  // Attribute this run's token usage to the agent's company budget (no-op for a
  // family specialist / the chief). Best-effort: metering must never break a run.
  recordUsage({ agent, model, usage }).catch((e) => log.warn("usage record failed", { agent, error: String(e?.message || e) }));
  // {text, requests}: requests is [] for every agent except a COO that emitted some.
  return { text, requests };
}
