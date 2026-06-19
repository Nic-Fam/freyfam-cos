import { complete, systemBlocks, textOf, parseJson } from "./claude.js";
import { MODELS } from "./config.js";

// ===========================================================================
// TRIAGE = the cost lever.
//
//  - Inbound: one cheap Haiku call decides which agent + how much horsepower
//    a message actually needs, so we route DOWN by default and only spend
//    Sonnet/Opus tokens when the work warrants it.
//  - Heartbeat: one cheap Haiku call decides whether anything is even
//    actionable before we wake a real (expensive) agent run. Most ticks are
//    no-ops and cost a fraction of a cent instead of a full Sonnet pass.
//
// Rough monthly math (15-min heartbeat, low household volume):
//    naive  (Sonnet every tick)   ~ $43/mo just for heartbeats
//    triaged (Haiku gate + escalate on hits only) ~ $13/mo
// ===========================================================================

const INBOUND_SYSTEM = `You are a routing classifier for a family's assistant. \
Classify the incoming message and respond with ONLY a JSON object, no prose, no code fences.

Schema:
{
  "agent": "chief-of-staff" | "finance" | "dev" | "resale",
  "complexity": "trivial" | "standard" | "complex",
  "high_stakes": boolean,   // money movement, sending email/SMS on the user's behalf, purchases, irreversible actions
  "summary": string         // <= 12 words
}

Guidance:
- "trivial": a fact lookup or one-line answer needing no tools.
- "standard": normal multi-step help (most messages).
- "complex": long-horizon, multi-tool, or ambiguous planning work.
- high_stakes is true whenever the request could spend money or send something outbound.`;

export async function triageInbound(message) {
  const resp = await complete({
    model: MODELS.triage,
    system: systemBlocks(INBOUND_SYSTEM),
    messages: [{ role: "user", content: message }],
    maxTokens: 200,
  });
  try {
    return parseJson(textOf(resp));
  } catch {
    // Fail safe: treat as standard chief-of-staff work, not high stakes.
    return { agent: "chief-of-staff", complexity: "standard", high_stakes: false, summary: message.slice(0, 60) };
  }
}

const HEARTBEAT_SYSTEM = `You are a watchdog for a family's assistant. You are given a compact list of \
recent signals (new email subjects/senders, calendar changes, reminders). Decide if ANY of them \
need action or a heads-up to the family right now. Respond with ONLY JSON, no prose, no code fences.

Schema:
{
  "actionable": boolean,
  "items": [ { "what": string, "agent": "chief-of-staff"|"finance"|"dev"|"resale", "urgency": "now"|"today"|"fyi" } ]
}

Be conservative: routine newsletters, receipts already filed, and noise are NOT actionable.`;

/**
 * @param {Array} signals  Cheap, pre-fetched deltas (no model needed to gather).
 *   e.g. [{ source:"email", from:"...", subject:"..." }, { source:"calendar", change:"..." }]
 */
export async function triageHeartbeat(signals) {
  if (!signals || signals.length === 0) return { actionable: false, items: [] };
  const resp = await complete({
    model: MODELS.triage,
    system: systemBlocks(HEARTBEAT_SYSTEM),
    messages: [{ role: "user", content: JSON.stringify(signals).slice(0, 6000) }],
    maxTokens: 400,
  });
  try {
    return parseJson(textOf(resp));
  } catch {
    return { actionable: false, items: [] };
  }
}
