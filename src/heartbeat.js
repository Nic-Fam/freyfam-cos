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
import { checkWatched, formatWatchFlags } from "./watch.js";
import { runFirstLookFeed, formatFeedItems } from "./resale-feed.js";
import { shouldRunGroceryOrder, assembleOrder, formatOrder, getLastGroceryRun, setLastGroceryRun, gatherGroceryItems, resolveGroceryOrder } from "./grocery.js";
import { formatResolution } from "./grocery-match.js";
import { listShopping } from "./shopping.js";
import { requestConfirmation } from "./confirm.js";
import { shouldAutoReply, isFamilyAddress } from "./guards.js";
import { recordLiveness } from "./liveness.js";
import { backupState } from "./backup.js";
import { checkOutageOnBoot, setLastSeen } from "./outage.js";
import { checkBreaches, newBreachFindings } from "./security-monitor.js";
import { addFinding, listFindings } from "./security.js";
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

// Off-site state backup (workstream R): snapshot data/ to Azure Blob on a slow
// cadence (default 6h) so a local disk failure costs at most one interval of state,
// not everything. Best-effort; backupState never throws.
let lastBackupAt = 0;
const BACKUP_INTERVAL_MS = Number(process.env.BACKUP_INTERVAL_MS || 6 * 60 * 60 * 1000);
async function maybeBackup() {
  const now = Date.now();
  if (now - lastBackupAt < BACKUP_INTERVAL_MS) return;
  lastBackupAt = now;
  await backupState();
}

// Frank's breach-feed monitor (read-only): on a weekly cadence, check the family's
// emails against HaveIBeenPwned; a NEW exposure becomes a high-severity finding +
// an owner alert. Inert until SECURITY_WATCH_EMAILS + HIBP_API_KEY are set.
let lastSecurityScanAt = 0;
const SECURITY_SCAN_INTERVAL_MS = Number(process.env.SECURITY_SCAN_INTERVAL_MS || 7 * 24 * 60 * 60 * 1000);
const SECURITY_WATCH_EMAILS = (process.env.SECURITY_WATCH_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
async function maybeSecurityScan() {
  const now = Date.now();
  if (now - lastSecurityScanAt < SECURITY_SCAN_INTERVAL_MS) return;
  lastSecurityScanAt = now;
  if (!SECURITY_WATCH_EMAILS.length) return; // not configured
  try {
    const { skipped, results } = await checkBreaches(SECURITY_WATCH_EMAILS);
    if (skipped) return;
    const seen = new Set((await listFindings()).map((f) => f.title));
    const fresh = newBreachFindings(results, seen);
    for (const b of fresh) {
      await addFinding({ title: b.title, severity: "high", summary: `${b.email} appears in the ${b.breach} breach (HaveIBeenPwned).`, recommendation: "Change that account's password and enable 2FA." });
      await notifyOwner(`Security: ${b.email} found in a new breach (${b.breach}). Frank logged it; consider changing that password.`);
    }
    log.info("security scan complete", { emails: SECURITY_WATCH_EMAILS.length, newExposures: fresh.length });
  } catch (err) {
    log.error("security scan failed", { reason: err.message });
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
        // TheRealReal First Look feed: read the early-access new-arrivals grid via
        // the LOCAL signed-in browser (Shelli's profile) and surface NEW items.
        // Generic web search can't see member-only early access, so this is its
        // own feed. No-ops gracefully (empty) if the profile isn't signed in.
        let feedNew = 0;
        try {
          const feed = await runFirstLookFeed();
          feedNew = feed.newItems.length;
          if (feedNew) await notifyOwner(`First Look new arrivals:\n${formatFeedItems(feed.newItems)}`);
        } catch (e) {
          log.error("first-look feed failed", { reason: e.message });
        }
        // Price-watch: re-check watched listings via the LOCAL browser (Lloyd) and
        // flag any drops / target hits. Done here on Lloyd, not the remote resale.
        const flagged = await checkWatched();
        if (flagged.length) await notifyOwner(`Price drop:\n${formatWatchFlags(flagged)}`);
        log.info("resale run complete", { slot: slot.label, priceFlags: flagged.length, firstLookNew: feedNew });
      } catch (err) {
        log.error("resale run failed", { slot: slot.label, reason: err.message });
      }
    }
  } catch (err) {
    log.error("resale schedule check failed", { reason: err.message });
  }
}

// Weekly Friday grocery order: assemble the shopping list into a Ralphs order and
// STAGE it for approval (the family gets Approve/Deny via email/Slack). On
// approval the "grocery" executor places it from Lloyd's local Mac. Once-per-day
// guard persisted so a restart can't re-propose.
async function maybeRunGroceryOrder() {
  try {
    const { run, date } = shouldRunGroceryOrder(new Date(), await getLastGroceryRun());
    if (!run) return;
    await setLastGroceryRun(date); // record before staging so a slow run can't double-propose
    // Source items from BOTH the local shopping list AND the M365 To Do "Ralphs"
    // list the Alexa "Frey" skill / fridge bridge fills (Alexa->grocery loop Phase 1).
    const items = await gatherGroceryItems({ store: "Ralphs", local: await listShopping() });
    if (!items.length) { log.info("grocery: skipped, empty shopping list", { date }); return; }
    // Phase 2: resolve each item to the exact product from purchase history. With no
    // history available yet (selectors pending), this is a no-op fall-back to free-text.
    const { orderItems, resolutions, history } = await resolveGroceryOrder({ items, store: "Ralphs" });
    const order = assembleOrder(orderItems);
    const note = history.length ? formatResolution(resolutions) : "";
    await requestConfirmation(
      `Friday Ralphs order (${order.count} items, ${order.deliveryWindow}, applying ${order.coupons.join(", ")}):\n${formatOrder(order)}` +
        (note ? `\n\nMatched to your usual products from purchase history:\n${note}` : ""),
      "grocery",
      order
    );
    log.info("grocery order proposed", { date, items: order.count, matched: resolutions.filter((r) => r.matched).length });
  } catch (err) {
    log.error("grocery order failed", { reason: err.message });
  }
}

let bootChecked = false;
export async function tick() {
  // On the FIRST tick after (re)start, detect whether Lloyd was offline for a real
  // gap and tell the owner he's back + catching up (workstream R). Reads the previous
  // run's last-seen before this tick refreshes it. Best-effort.
  if (!bootChecked) {
    bootChecked = true;
    await checkOutageOnBoot({ notify: notifyOwner });
  }
  // Dead-man's-switch heartbeat FIRST (workstream R): record that Lloyd is alive so
  // the off-Mac monitor can alert the family if this stops. Best-effort, never throws.
  await recordLiveness();
  await setLastSeen(); // local heartbeat stamp for boot-time outage detection
  await maybeCheckCosts();
  await maybeBackup();
  await maybeSecurityScan();
  await maybeRunDigest();
  await maybeFireReminders();
  await maybeRunResale();
  await maybeRunGroceryOrder();

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
