import { HEARTBEAT_INTERVAL_MS, COST, MODELS, DIGEST } from "./config.js";
import { triageHeartbeat } from "./triage.js";
import { recentMailSignals } from "./channels/graph.js";
import { getExpiringSoon } from "./meals.js";
import { runChief } from "./orchestrator.js";
import { notifyOwner } from "./channels/twilio.js";
import { checkCostThresholds } from "./cost.js";
import { runMorningDigest, shouldRunDigest } from "./digest.js";
import { shouldAutoReply } from "./guards.js";
import { createLogger } from "./log.js";

const log = createLogger("heartbeat");

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
    // Drop bounce/no-reply/automated/self mail so a delivery loop or our own
    // outbound never becomes a proactive escalation (shouldAutoReply == legit human).
    const mail = (await recentMailSignals({ top: 15 })).filter((s) => shouldAutoReply(s.from));
    signals.push(...mail);
  } catch (err) {
    log.error("mail signal fetch failed", { reason: err.message });
  }
  try {
    // Kitchen items expiring within 2 days (or already past) -> the chef's beat (Carmine).
    for (const it of await getExpiringSoon(2)) {
      signals.push({ source: "kitchen", item: it.name, expiresAt: it.expiresAt, daysUntil: it.daysUntil });
    }
  } catch (err) {
    log.error("kitchen signal fetch failed", { reason: err.message });
  }
  // TODO (Claude Code): add calendar deltas, reminders, resale saved-search hits.
  return signals;
}

// Cost meters bill per cycle, not per minute, so we check them on their own
// slower cadence (default hourly) rather than every heartbeat tick.
let lastCostCheckAt = 0;

async function maybeCheckCosts() {
  const now = Date.now();
  if (now - lastCostCheckAt < COST.checkIntervalMs) return;
  lastCostCheckAt = now;
  try {
    await checkCostThresholds(new Date(), { notify: notifyOwner });
  } catch (err) {
    log.error("cost check failed", { reason: err.message });
  }
}

// Morning digest: fire once per local day in the morning window. Lloyd composes
// it by delegating to the specialists (see digest.js).
let lastDigestDate = null;

async function maybeRunDigest() {
  if (!DIGEST.enabled) return;
  const { run, date } = shouldRunDigest(new Date(), lastDigestDate, DIGEST);
  if (!run) return;
  lastDigestDate = date; // record before running so a slow run can't double-fire
  try {
    await runMorningDigest();
    log.info("morning digest sent", { date });
  } catch (err) {
    log.error("morning digest failed", { reason: err.message });
  }
}

export async function tick() {
  await maybeCheckCosts();
  await maybeRunDigest();

  const signals = await gatherSignals();
  const verdict = await triageHeartbeat(signals);
  if (!verdict.actionable) return;

  for (const item of verdict.items) {
    if (item.urgency === "fyi") {
      await notifyOwner(`FYI: ${item.what}`);
      continue;
    }
    // Run the chief directly (triageHeartbeat already judged this, so no second
    // triage) and deliver the result to the owner. Previously this faked an
    // inbound SMS from "heartbeat", which threw in sendSms and dropped the result.
    try {
      const model = item.urgency === "now" ? MODELS.heavy : MODELS.standard;
      const result = await runChief(
        `Proactive task (${item.agent}, ${item.urgency}): ${item.what}`,
        model
      );
      await notifyOwner(`Proactive (${item.agent}, ${item.urgency}): ${result}`);
    } catch (e) {
      log.error("escalation failed", { reason: e.message, item: item.what });
    }
  }
}

export function startHeartbeat() {
  log.info("scheduled", { intervalMin: Math.round(HEARTBEAT_INTERVAL_MS / 60000) });
  tick().catch((e) => log.error("first tick failed", { reason: e.message }));
  return setInterval(() => tick().catch((e) => log.error("tick failed", { reason: e.message })), HEARTBEAT_INTERVAL_MS);
}
