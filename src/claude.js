import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("claude");
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
// The STABLE prefix (tools + persona) uses the 1-HOUR cache TTL so a follow-up
// turn on the same model 5-60 minutes later reads the persona from cache instead
// of re-paying full price. (Note: caches are per MODEL, and the heartbeat gate
// runs its own small Haiku prompt, so the 1h TTL only pays off for same-model
// follow-ups; a 1h write costs 2x input vs 1.25x for 5m. Watch the
// cache_write_1h vs cache_read columns in the "model call" log line and drop to
// the default TTL if reads don't dominate.) The per-turn conversation
// breakpoint stays 5 min (it changes every turn anyway). Descending TTL down the
// prompt (tools/system 1h -> messages 5m) is the required order. The 1h TTL is
// GA; no beta header is needed.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Thinking + effort (policy 2026-10-11). On the current generation (Sonnet 5.x,
// Opus 5.x, Haiku 5.5) adaptive thinking is ON whenever the `thinking` param is
// omitted, and the thinking tokens count against `max_tokens`. The old code
// never set `thinking` or an effort level and ran the chief loop at
// max_tokens 2048, so a tool-heavy turn could spend the whole budget thinking,
// stop with stop_reason "max_tokens", and return ZERO text. That is the
// 2026-07-01 "digest composed 0 chars" incident, which was blamed on the model
// (claude-sonnet-5) instead of the request shape.
//
// So: (1) every request carries an explicit `output_config.effort`, chosen per
// model tier (env-overridable), "low" for the cheap classifier/specialist tier
// and "medium" for the chief + Sonnet/Opus specialists; (2) the agent loop's
// default max_tokens is 8192; (3) `stop_reason` is checked on every response
// and a truncation retries once with a doubled cap before surfacing a sentinel.
// Effort is only sent to models that accept it (Haiku 4.5 and older 400 on it).
// ---------------------------------------------------------------------------
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** True for model ids that accept output_config.effort (Opus 4.5+, Sonnet 4.6+, Haiku 5+, Fable). */
export function supportsEffort(model) {
  const m = String(model || "");
  return /^claude-(opus-4-[5-9]|opus-[5-9]|sonnet-4-[6-9]|sonnet-[5-9]|haiku-[5-9]|fable|mythos)/.test(m);
}

/**
 * Effort for a model: explicit override > env per family > default by family.
 * Haiku (triage/classifier/light specialists) -> low; Sonnet/Opus -> medium.
 * Env: COS_EFFORT_HAIKU, COS_EFFORT_SONNET, COS_EFFORT_OPUS (low|medium|high|xhigh|max).
 */
export function effortFor(model, override) {
  if (override && EFFORT_LEVELS.has(override)) return override;
  const m = String(model || "");
  const env = (k) => {
    const v = String(process.env[k] || "").toLowerCase();
    return EFFORT_LEVELS.has(v) ? v : null;
  };
  if (m.includes("haiku")) return env("COS_EFFORT_HAIKU") || "low";
  if (m.includes("opus") || m.includes("fable") || m.includes("mythos")) return env("COS_EFFORT_OPUS") || "medium";
  return env("COS_EFFORT_SONNET") || "medium";
}

/**
 * Build the Messages API request body. Pure; exported so tests can assert the
 * request shape (effort placement, caching markers) without a network call.
 */
export function buildRequest({ model, system, messages, tools, maxTokens = 4096, cacheConversation = false, effort } = {}) {
  const req = {
    model,
    max_tokens: maxTokens,
    messages: cacheConversation ? withConvoCacheBreakpoint(messages) : messages,
  };
  if (system) req.system = system;
  if (tools && tools.length) {
    // Mark the final tool so the whole tool block is cached — 1h TTL, same as the
    // persona, so the stable prefix (tools + system) survives between turns.
    req.tools = tools.map((t, i) =>
      i === tools.length - 1
        ? { ...t, cache_control: { type: "ephemeral", ttl: STABLE_TTL } }
        : t
    );
  }
  if (supportsEffort(model)) req.output_config = { effort: effortFor(model, effort) };
  return req;
}

/** One structured log line per API call: the per-run usage record the cost review asked for. */
function logUsage(req, resp, ms) {
  const u = resp?.usage || {};
  const cc = u.cache_creation || {};
  log.info("model call", {
    model: req.model,
    effort: req.output_config?.effort || null,
    stop_reason: resp?.stop_reason || null,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    cache_write: u.cache_creation_input_tokens || 0,
    cache_write_1h: cc.ephemeral_1h_input_tokens ?? null,
    cache_write_5m: cc.ephemeral_5m_input_tokens ?? null,
    tools: req.tools?.length || 0,
    ms,
  });
}

/**
 * Single completion. Caches tools (last tool gets the breakpoint) and system,
 * sends an explicit effort, and logs stop_reason + usage. `cacheConversation`
 * adds a third breakpoint on the growing message history (the agent loop sets
 * it) so multi-turn runs don't re-pay for prior turns.
 */
export async function complete(opts) {
  const req = buildRequest(opts);
  const t0 = Date.now();
  const resp = await client.messages.create(req);
  logUsage(req, resp, Date.now() - t0);
  if (resp?.stop_reason === "max_tokens") {
    log.warn("response truncated at max_tokens", { model: req.model, max_tokens: req.max_tokens, text_chars: textOf(resp).length });
  } else if (resp?.stop_reason === "refusal") {
    log.warn("model refused", { model: req.model, category: resp?.stop_details?.category || null });
  }
  return resp;
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

export const TRUNCATED_SENTINEL = "(stopped: output truncated at max_tokens)";
export const MAX_TURNS_SENTINEL = "(stopped: max tool turns reached)";
const MAX_TOKENS_CEILING = Number(process.env.COS_MAX_TOKENS_CEILING || 16384);

/**
 * Run a full tool-use loop until the model returns a text-only answer.
 * `toolHandlers` is a map of toolName -> async (input) => result.
 *
 * Truncation: a turn that stops at max_tokens is retried ONCE with a doubled
 * cap (bounded by COS_MAX_TOKENS_CEILING). Tool uses from a truncated turn are
 * never executed (the last input may be incomplete). If the retry is truncated
 * too, the loop returns whatever text it has, or TRUNCATED_SENTINEL when there
 * is none, with `truncated: true` so callers can react.
 */
export async function agentLoop({
  model,
  system,
  messages,
  tools,
  toolHandlers,
  maxTokens = 8192,
  maxTurns = 8,
  effort,
}) {
  const convo = [...messages];
  // Aggregate token usage across EVERY turn of the loop (each complete() bills
  // separately), so callers can attribute the full run's cost - not just the last
  // turn's - to an agent (the per-COO cost ledger, workstream S step 3). Additive:
  // existing callers that destructure {text} ignore this.
  const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation_1h_input_tokens: 0, cache_creation_5m_input_tokens: 0 };
  const addUsage = (u) => {
    if (!u) return;
    usage.input_tokens += u.input_tokens || 0;
    usage.output_tokens += u.output_tokens || 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
    usage.cache_creation_1h_input_tokens += u.cache_creation?.ephemeral_1h_input_tokens || 0;
    usage.cache_creation_5m_input_tokens += u.cache_creation?.ephemeral_5m_input_tokens || 0;
  };
  let cap = maxTokens;
  let retriedTruncation = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    // cacheConversation: read prior turns/history from cache instead of
    // reprocessing them at full price on every turn of the loop.
    const resp = await complete({ model, system, messages: convo, tools, maxTokens: cap, cacheConversation: true, effort });
    addUsage(resp.usage);
    if (resp.stop_reason === "max_tokens") {
      if (!retriedTruncation && cap < MAX_TOKENS_CEILING) {
        retriedTruncation = true;
        cap = Math.min(cap * 2, MAX_TOKENS_CEILING);
        log.warn("agent loop turn truncated; retrying once with a larger cap", { model, max_tokens: cap });
        turn--; // the retry is not a new tool turn
        continue;
      }
      const text = textOf(resp);
      log.error("agent loop turn truncated twice; giving up", { model, max_tokens: cap, text_chars: text.length });
      return { text: text || TRUNCATED_SENTINEL, resp, convo, usage, truncated: true };
    }
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
  return { text: MAX_TURNS_SENTINEL, convo, usage };
}

// Parse a JSON-only model reply, tolerating accidental code fences.
// Throw-SAFE: callers use `parseJson(x) || {}` expecting null on failure (a
// truncated/malformed model response must not throw and abort the pipeline).
// Salvages the largest {...} span when there's surrounding prose, and retries
// after trimming a trailing partial element when the JSON was cut off mid-array.
export function parseJson(text) {
  let clean = String(text ?? "").replace(/```json|```/g, "").trim();
  const first = clean.indexOf("{");
  const last = clean.lastIndexOf("}");
  if (first > 0 || (last >= 0 && last < clean.length - 1)) clean = clean.slice(first, last + 1);
  try {
    return JSON.parse(clean);
  } catch {
    // Recover truncated output: cut back to the last complete element and close.
    const cut = Math.max(clean.lastIndexOf("},"), clean.lastIndexOf("],"));
    if (cut > 0) {
      try { return JSON.parse(clean.slice(0, cut + 1) + "]}"); } catch { /* give up */ }
    }
    return null;
  }
}
