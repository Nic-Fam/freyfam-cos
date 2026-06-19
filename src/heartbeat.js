import { HEARTBEAT_INTERVAL_MS } from "./config.js";
import { triageHeartbeat } from "./triage.js";
import { recentMailSignals } from "./channels/graph.js";
import { getExpiringSoon } from "./meals.js";
import { handleInbound } from "./orchestrator.js";
import { notifyOwner } from "./channels/twilio.js";

// ===========================================================================
// The heartbeat is what makes the assistant proactive instead of reactive.
// Each tick is intentionally cheap:
//   1. gather signals with plain API reads (NO model tokens)
//   2. one Haiku triage call to decide if anything matters
//   3. only on a hit do we spend Sonnet/Opus tokens to actually act
// Idle ticks therefore cost a fraction of a cent.
// ===========================================================================

async function gatherSignals() {
  const signals = [];
  try {
    signals.push(...(await recentMailSignals({ top: 15 })));
  } catch (err) {
    console.error("[heartbeat] mail signal fetch failed:", err.message);
  }
  try {
    // Kitchen items expiring within 2 days (or already past) -> the chef's beat (Carmen).
    for (const it of await getExpiringSoon(2)) {
      signals.push({ source: "kitchen", item: it.name, expiresAt: it.expiresAt, daysUntil: it.daysUntil });
    }
  } catch (err) {
    console.error("[heartbeat] kitchen signal fetch failed:", err.message);
  }
  // TODO (Claude Code): add calendar deltas, reminders, resale saved-search hits.
  return signals;
}

export async function tick() {
  const signals = await gatherSignals();
  const verdict = await triageHeartbeat(signals);
  if (!verdict.actionable) return;

  for (const item of verdict.items) {
    if (item.urgency === "fyi") {
      await notifyOwner(`FYI: ${item.what}`);
      continue;
    }
    // Escalate to a real agent run by feeding it back through the orchestrator.
    await handleInbound({
      from: "heartbeat",
      replyTo: undefined, // results go to owner via notifyOwner below
      channel: "sms",
      body: `Proactive task (${item.agent}, ${item.urgency}): ${item.what}`,
    }).catch((e) => console.error("[heartbeat] escalation failed:", e.message));
  }
}

export function startHeartbeat() {
  console.log(`[heartbeat] every ${Math.round(HEARTBEAT_INTERVAL_MS / 60000)} min`);
  tick().catch((e) => console.error("[heartbeat] first tick:", e.message));
  return setInterval(() => tick().catch((e) => console.error("[heartbeat]", e.message)), HEARTBEAT_INTERVAL_MS);
}
