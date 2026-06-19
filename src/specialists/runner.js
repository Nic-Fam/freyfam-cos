import { agentLoop, systemBlocks } from "../claude.js";
import { MODELS } from "../config.js";
import { recall } from "../memory.js";
import { persona } from "../persona.js";
import { specialistTools } from "../agents/tools.js";

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

export async function runSpecialist(agent, task) {
  const p = await persona(agent);
  const mems = await recall(task, 4, { agent });
  const ctx = mems.length ? `Relevant memory:\n${mems.map((m) => "- " + m.text).join("\n")}` : "";
  const { tools: specTools, handlers: specHandlers } = specialistTools(agent);
  const { text } = await agentLoop({
    model: MODELS.standard,
    system: systemBlocks(p, ctx),
    messages: [{ role: "user", content: task }],
    tools: specTools,
    toolHandlers: specHandlers,
    maxTurns: 6,
  });
  return text;
}
