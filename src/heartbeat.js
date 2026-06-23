import { HEARTBEAT_INTERVAL_MS, COST, MODELS, DIGEST } from "./config.js";
import { triageHeartbeat } from "./triage.js";
import { recentMailSignals } from "./channels/graph.js";
import { getExpiringSoon } from "./meals.js";
import { runChief } from "./orchestrator.js";
import { notifyOwner } from "./channels/twilio.js";
import { checkCostThresholds } from "./cost.js";
import { runMorningDigest, shouldRunDigest, getLastDigestDate, setLastDigestDate } from "./digest.js";
import { getDueReminders, afterFired } from "./reminders.js";
import { dueSlots, getResaleState, setSlotRan } from "./resale-schedule.js";
import { delegate } from "./delegate.js";
import { shouldAutoReply, isFamilyAddress } from "./guards.js";
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
    // Tag the family's OWN addresses so triage/security never read their normal
    // mail activity (volume, forwards, links they share) as a threat.
    const mail = (await recentMailSignals({ top: 15 }))
      .filter((s) => shouldAutoReply(s.from))
      .map((s) => ({ ...s, fromFamily: isFamilyAddress(s.from) }));
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
// it by delegating to the specialists (see digest.js). The once-per-day guard is
// PERSISTED (digest-state.json) so frequent daemon restarts inside the window
// don't re-fire it.
async function maybeRunDigest() {
  if (!DIGEST.enabled) return;
  const lastDigestDate = await getLastDigestDate();
  const { run, date } = shouldRunDigest(new Date(), lastDigestDate, DIGEST);
  if (!run) return;
  await setLastDigestDate(date); // persist BEFORE running so a restart mid-run can't double-fire
  try {
    await runMorningDigest();
    log.info("morning digest sent", { date });
  } catch (err) {
    log.error("morning digest failed", { reason: err.message });
  }
}

// Fire any reminders that have come due: notify the owner, then re-arm recurring
// ones / mark one-shots done. Persisted, so a restart never drops one.
async function maybeFireReminders() {
  try {
    for (const r of await getDueReminders()) {
      await notifyOwner(`Reminder: ${r.message}`);
      await afterFired(r.id);
      log.info("reminder fired", { id: r.id });
    }
  } catch (err) {
    log.error("reminder check failed", { reason: err.message });
  }
}

// Twice-daily resale run (right after TheRealReal's 7am/4pm PT drops). Delegates
// to Shey to run the saved searches; she reports NEW matches or "NONE", and we
// only ping the family when there's something new. This is what makes the saved
// searches behave like a feed: fresh listings surface on their own.
async function maybeRunResale() {
  try {
    const state = await getResaleState();
    const { due, date } = dueSlots(new Date(), state);
    for (const slot of due) {
      await setSlotRan(slot.label, date); // record before running so a slow run can't double-fire
      try {
        const res = await delegate({
          agent: "resale",
          task: "Run all saved searches now (run_saved_searches) and report ONLY new matches since last time. If there are no new matches, reply with exactly: NONE",
        });
        if (res && !/^\s*NONE\s*\.?\s*$/i.test(res)) await notifyOwner(`New resale finds:\n${res}`);
        log.info("resale run complete", { slot: slot.label });
      } catch (err) {
        log.error("resale run failed", { slot: slot.label, reason: err.message });
      }
    }
  } catch (err) {
    log.error("resale schedule check failed", { reason: err.message });
  }
}

export async function tick() {
  await maybeCheckCosts();
  await maybeRunDigest();
  await maybeFireReminders();
  await maybeRunResale();

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
