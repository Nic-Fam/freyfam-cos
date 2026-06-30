import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config.js";

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Live model catalog (GET /v1/models). Used by model-registry.js to discover the
// newest model per tier as Anthropic ships them. Collects the auto-paginating
// list into a plain array. Each entry has at least { id, created_at }.
export async function listModels() {
  const out = [];
  for await (const m of client.models.list()) out.push(m);
  return out;
}

// ---------------------------------------------------------------------------
// Prompt caching. Caching references the prompt in the order: tools, system,
// messages. We mark the STABLE prefix (tools + persona system block) with
// cache_control so every turn only pays full price for the new user content.
// Cache reads cost ~10% of input; this is the single biggest lever after triage.
// The STABLE prefix (tools + persona) uses the 1-HOUR cache TTL so it survives across
// heartbeat ticks (every ~15 min) and bursty back-and-forth conversations, instead of
// expiring after the default 5 min and re-paying full price for the persona each tick.
// The per-turn conversation breakpoint stays 5 min (it changes every turn anyway).
// Descending TTL down the prompt (tools/system 1h -> messages 5m) is the required order.
// 1h TTL needs the extended-cache-ttl beta header (sent in complete()).
const STABLE_TTL = "1h";
function cacheable(text, ttl) {
  const cache_control = ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" };
  return { type: "text", text, cache_control };
}

/**
 * Build a system array with the stable persona cached.
 * @param {string} stable  Persona / instructions that rarely change -> cached (1h TTL).
 * @param {string} [volatile] Per-turn context (date, fresh signals) -> not cached.
 */
export function systemBlocks(stable, volatile, { ttl = STABLE_TTL } = {}) {
  const blocks = [cacheable(stable, ttl)];
  if (volatile) blocks.push({ type: "text", text: volatile });
  return blocks;
}

/**
 * Add an ephemeral cache breakpoint to the last block of the last message, so a
 * multi-turn tool loop (and replayed conversation history) READS the earlier
 * turns from cache (~10% of input) instead of reprocessing them at full price
 * every turn. Skipped for a single fresh user message (nothing prior to cache,
 * so the breakpoint would only pay a write premium with no later read).
 * Returns a shallow copy; never mutates the caller's array/blocks.
 */
export function withConvoCacheBreakpoint(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  let content = last.content;
  if (typeof content === "string") {
    content = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(content) && content.length) {
    content = content.slice();
    content[content.length - 1] = {
      ...content[content.length - 1],
      cache_control: { type: "ephemeral" },
    };
  } else {
    return messages; // empty/odd content -> leave as-is
  }
  out[out.length - 1] = { ...last, content };
  return out;
}

/**
 * Single completion. Caches tools (last tool gets the breakpoint) and system.
 * `cacheConversation` adds a third breakpoint on the growing message history
 * (the agent loop sets it) so multi-turn runs don't re-pay for prior turns.
 */
export async function complete({
  model,
  system,
  messages,
  tools,
  maxTokens = 1024,
  cacheConversation = false,
}) {
  const req = {
    model,
    max_tokens: maxTokens,
    messages: cacheConversation ? withConvoCacheBreakpoint(messages) : messages,
  };
  if (system) req.system = system;
  if (tools && tools.length) {
    // Mark the final tool so the whole tool block is cached — 1h TTL, same as the
    // persona, so the stable prefix (tools + system) survives between heartbeat ticks.
    req.tools = tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: { type: "ephemeral", ttl: STABLE_TTL } }
        : t
    );
  }
  // The 1h cache TTL requires the extended-cache-ttl beta header. Harmless if the
  // feature is GA; required while it's beta.
  return client.messages.create(req, { headers: { "anthropic-beta": "extended-cache-ttl-2025-04-11" } });
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
  // Aggregate token usage across EVERY turn of the loop (each complete() bills
  // separately), so callers can attribute the full run's cost - not just the last
  // turn's - to an agent (the per-COO cost ledger, workstream S step 3). Additive:
  // existing callers that destructure {text} ignore this.
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usage.input_tokens += u.input_tokens || 0;
    usage.output_tokens += u.output_tokens || 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
  };
  for (let turn = 0; turn < maxTurns; turn++) {
    // cacheConversation: read prior turns/history from cache instead of
    // reprocessing them at full price on every turn of the loop.
    const resp = await complete({ model, system, messages: convo, tools, maxTokens, cacheConversation: true });
    addUsage(resp.usage);
    const uses = toolUses(resp);
    if (uses.length === 0) return { text: textOf(resp), resp, convo, usage };

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
  return { text: "(stopped: max tool turns reached)", convo, usage };
}

// Parse a JSON-only model reply, tolerating accidental code fences.
export function parseJson(text) {
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}
