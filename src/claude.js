import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config.js";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Prompt caching. Caching references the prompt in the order: tools, system,
// messages. We mark the STABLE prefix (tools + persona system block) with
// cache_control so every turn only pays full price for the new user content.
// Cache reads cost ~10% of input; this is the single biggest lever after triage.
// Default TTL is 5 min; pass ttl:"1h" for the heartbeat if ticks are >5 min apart.
// ---------------------------------------------------------------------------
function cacheable(text, ttl) {
  const cache_control = ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
  return { type: "text", text, cache_control };
}

/**
 * Build a system array with the stable persona cached.
 * @param {string} stable  Persona / instructions that rarely change -> cached.
 * @param {string} [volatile] Per-turn context (date, fresh signals) -> not cached.
 */
export function systemBlocks(stable, volatile, { ttl } = {}) {
  const blocks = [cacheable(stable, ttl)];
  if (volatile) blocks.push({ type: "text", text: volatile });
  return blocks;
}

/**
 * Single completion. Caches tools (last tool gets the breakpoint) and system.
 */
export async function complete({
  model,
  system,
  messages,
  tools,
  maxTokens = 1024,
}) {
  const req = { model, max_tokens: maxTokens, messages };
  if (system) req.system = system;
  if (tools && tools.length) {
    // Mark the final tool so the whole tool block is treated as a cached prefix.
    req.tools = tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: { type: "ephemeral" } }
        : t
    );
  }
  return client.messages.create(req);
}

export function textOf(resp) {
  return (resp.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function toolUses(resp) {
  return (resp.content || []).filter((b) => b.type === "tool_use");
}

/**
 * Run a full tool-use loop until the model returns a text-only answer.
 * `toolHandlers` is a map of toolName -> async (input) => result.
 */
export async function agentLoop({
  model,
  system,
  messages,
  tools,
  toolHandlers,
  maxTokens = 2048,
  maxTurns = 8,
}) {
  const convo = [...messages];
  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await complete({ model, system, messages: convo, tools, maxTokens });
    const uses = toolUses(resp);
    if (uses.length === 0) return { text: textOf(resp), resp, convo };

    convo.push({ role: "assistant", content: resp.content });
    const results = [];
    for (const u of uses) {
      let result;
      try {
        const handler = toolHandlers[u.name];
        result = handler
          ? await handler(u.input)
          : `No handler registered for tool "${u.name}".`;
      } catch (err) {
        result = `Tool "${u.name}" failed: ${err.message}`;
      }
      results.push({
        type: "tool_result",
        tool_use_id: u.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
    convo.push({ role: "user", content: results });
  }
  return { text: "(stopped: max tool turns reached)", convo };
}

// Parse a JSON-only model reply, tolerating accidental code fences.
export function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}
