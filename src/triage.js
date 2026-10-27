import { createHash } from "node:crypto";
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
  "agent": "chief-of-staff" | "finance" | "dev" | "resale" | "chef" | "security",
  "complexity": "trivial" | "standard" | "complex",
  "high_stakes": boolean,   // money movement, sending email/SMS on the user's behalf, purchases, irreversible actions
  "summary": string         // <= 12 words
}

Guidance:
- "trivial": a fact lookup or one-line answer needing no tools.
- "standard": normal multi-step help (most messages).
- "complex": long-horizon, multi-tool, or ambiguous planning work.
- "chef": meal planning and kitchen inventory (what's for dinner, what's in the fridge,
  what's expiring, logging groceries used). Note: actually BUYING groceries is high_stakes.
- "security": home + IT security (suspicious logins, phishing, breaches, devices/updates,
  alarms/cameras/locks). Note: any control action (arm/disarm, lock, password change) is high_stakes.
- high_stakes is true whenever the request could spend money or send something outbound.`;

export async function triageInbound(message) {
  const resp = await complete({
    model: MODELS.triage,
    system: systemBlocks(INBOUND_SYSTEM),
    messages: [{ role: "user", content: message }],
    // Haiku 5.5 thinks before answering and the thinking counts against
    // max_tokens, so leave room (the JSON itself is ~60 tokens).
    maxTokens: 1024,
  });
  return inboundVerdict(parseJson(textOf(resp)), message);
}

/**
 * Normalize a parsed inbound-triage reply. `parseJson` never throws; it returns
 * null on a garbled/truncated/prose reply, so the fail-safe has to be applied
 * here (the old try/catch around it was dead code, and the null reached the
 * orchestrator as `t.complexity` -> TypeError -> the message retried to the
 * poison queue). Fail SAFE: an unusable verdict is treated as high-stakes
 * standard chief work, so a malformed message can't slip under the high-stakes
 * posture. (Model cost is unchanged — high_stakes is a Sonnet floor, not Opus.)
 * Pure; exported for tests.
 */
export function inboundVerdict(parsed, message = "") {
  const fallback = { agent: "chief-of-staff", complexity: "standard", high_stakes: true, summary: String(message).slice(0, 60) };
  if (!parsed || typeof parsed !== "object") return fallback;
  const complexity = ["trivial", "standard", "complex"].includes(parsed.complexity) ? parsed.complexity : "standard";
  return {
    agent: typeof parsed.agent === "string" && parsed.agent ? parsed.agent : "chief-of-staff",
    complexity,
    high_stakes: parsed.high_stakes === undefined ? true : Boolean(parsed.high_stakes),
    summary: typeof parsed.summary === "string" ? parsed.summary : fallback.summary,
  };
}

const HEARTBEAT_SYSTEM = `You are a watchdog for a family's assistant. You are given a compact list of \
recent signals (new email subjects/senders, calendar changes, reminders, expiring food). Decide if \
ANY of them need action or a heads-up to the family right now. Respond with ONLY JSON, no prose, no code fences.

Schema:
{
  "actionable": boolean,
  "items": [ { "what": string, "agent": "chief-of-staff"|"finance"|"dev"|"resale"|"chef"|"security", "urgency": "now"|"today"|"fyi" } ]
}

Route expiring/expired kitchen items to "chef" (urgency "fyi" unless it is a lot of food).
Route security-relevant signals to "security" ONLY for genuinely EXTERNAL anomalies: a
sign-in/breach/password-reset notice from a real service, a phishing attempt from an
outside sender, an unknown sender impersonating someone, a home-system/device alert.

Routine account notices (a password reset, a new sign-in, a verification code, a 2FA
change) are almost always the family themselves: urgency "fyi", NOT "now", unless the
notice itself says the attempt was unrecognized, blocked, or not them.

The family's OWN mail is NEVER a security threat. A signal with "fromFamily": true (or
from one of the family's addresses) is normal activity: do NOT flag their email volume,
their replies, forwards, bounce/undeliverable notices, or links THEY share (e.g. a
daycare/Woodbury Preschool curriculum URL, even if it looks long or obfuscated) as
compromise or phishing. Many emails from a family member is normal, not a breach.

Be conservative: routine newsletters, receipts already filed, the family's own mail, and
noise are NOT actionable.`;

/**
 * Stable, order-independent fingerprint of a heartbeat signal set. The tick uses
 * it as a cheap LOCAL gate: if the signals are byte-for-byte the same as the
 * previous tick, nothing changed and we skip the Haiku triage call entirely
 * (the common case -- the recent-mail window and expiring-food list rarely move
 * between 30-min ticks). This is the same idea as the empty-signal short-circuit
 * below, extended to "unchanged" so we stop re-paying Haiku to re-conclude
 * "nothing new", and as a bonus never re-escalate an unchanged signal.
 *
 * Keys off each signal's IDENTITY, not derived/volatile fields: mail by
 * sender+subject+receivedAt, kitchen by item+expiry (NOT daysUntil, which ticks
 * down daily for the same item and would defeat the gate). Returns "empty" for
 * no signals so an all-quiet tick has a stable fingerprint too.
 */
export function signalsFingerprint(signals = []) {
  if (!signals || signals.length === 0) return "empty";
  const keys = signals.map((s) => {
    if (s.id) return `id:${s.id}`;
    if (s.source === "kitchen") return `kitchen:${s.item}|${s.expiresAt}`;
    if (s.from || s.subject) return `mail:${s.from || ""}|${s.subject || ""}|${s.receivedAt || ""}`;
    return `json:${JSON.stringify(s)}`;
  });
  keys.sort(); // order-independent: a reshuffled-but-identical set is "unchanged"
  return createHash("sha1").update(keys.join("\n")).digest("hex");
}

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
    maxTokens: 1536, // room for adaptive thinking + a multi-item verdict
  });
  return heartbeatVerdict(parseJson(textOf(resp)));
}

/** Normalize a parsed heartbeat-triage reply (null/garbage -> not actionable). Pure. */
export function heartbeatVerdict(parsed) {
  if (!parsed || typeof parsed !== "object" || !parsed.actionable) return { actionable: false, items: [] };
  const items = (Array.isArray(parsed.items) ? parsed.items : []).filter((it) => it && typeof it.what === "string" && it.what.trim());
  return { actionable: items.length > 0, items };
}
