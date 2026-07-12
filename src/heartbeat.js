import { HEARTBEAT_INTERVAL_MS, COST, MODELS, DIGEST, FINANCE_REPORT, PACKAGE_DIGEST, AMAZON_DIGEST, COO_REVIEW } from "./config.js";
import { triageHeartbeat, signalsFingerprint } from "./triage.js";
import { shouldAlert, recordAlerted } from "./heartbeat-alerts.js";
import { recentMailSignals, recentShipmentMail, listEvents } from "./channels/graph.js";
import { listReceipts, leftoverEstimate, markLeftoverProcessed, pendingExtraction, extractReceipts, applyExtraction } from "./receipts.js";
import { processShipmentEmail, isShippingEmail, isDeliveryConfirmation, listPickupsNeedingSchedule, markPickupScheduled } from "./packages.js";
import { getExpiringSoon } from "./meals.js";
import { runChief } from "./orchestrator.js";
import { notifyOwner } from "./channels/notify.js";
import { checkCostThresholds } from "./cost.js";
import { discoverModelTiers, changeKey, getModelNotifyState, setModelNotifyState } from "./model-registry.js";
import { runMorningDigest, shouldRunDigest, getLastDigestDate, setLastDigestDate, getDigestAlertedDate, setDigestAlertedDate, localParts } from "./digest.js";
import { buildDailyIngest, getLastIngestDate, setLastIngestDate, scanInboxForAlerts } from "./finance-ingest.js";
import { isCreditStatement, scanInboxForStatements } from "./credit-statement.js";
import { reconcileInboundEmail } from "./email-reconcile.js";
import { runWeeklyFinanceReport, shouldRunWeeklyReport, getLastReportDate, setLastReportDate } from "./finance-report.js";
import { WEEK_CONFLICTS, shouldRunWeekConflicts, getLastConflictRun, setLastConflictRun, runWeekAheadConflicts } from "./week-conflicts.js";
import { transferOutlook, shouldRunTransferOutlook, getLastOutlookCycle, setLastOutlookCycle } from "./transfer-outlook.js";
import { runPackageDigest, shouldRunPackageDigest, getLastPackageDigestDate, setLastPackageDigestDate } from "./package-digest.js";
import { runAmazonDigest, shouldRunAmazonDigest, getLastAmazonDigestDate, setLastAmazonDigestDate } from "./amazon-digest.js";
import { getDueReminders, afterFired } from "./reminders.js";
import { dueSlots, getResaleState, setSlotRan } from "./resale-schedule.js";
import { delegate, chooseTransport } from "./delegate.js";
import { runSavedSearches, fetchHuntsViaDelegate, formatSavedSearchRun } from "./saved-searches.js";
import { cooRoster } from "./companies.js";
import { runCooReview, shouldRunReview, getReviewState, setReviewRan } from "./coo-review.js";
import { budgetState } from "./cost-ledger.js";
import { checkWatched, formatWatchFlags } from "./watch.js";
import { runFirstLookFeed, formatFeedItems } from "./resale-feed.js";
import { runBoutiqueFeeds, formatBoutiqueFeed } from "./boutique-feed.js";
import { shouldRunGroceryOrder, assembleOrder, formatOrder, getLastGroceryRun, setLastGroceryRun, gatherGroceryItems, resolveGroceryOrder } from "./grocery.js";
import { formatResolution } from "./grocery-match.js";
import { listShopping } from "./shopping.js";
import { requestConfirmation } from "./confirm.js";
import { shouldAutoReply, isFamilyAddress, isSelfAddress } from "./guards.js";
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
  // TODO (Claude Code): add calendar deltas. (Reminders fire via maybeFireReminders;
  // shipments are recorded by maybeScanShipments; resale runs on its own schedule.)
  return signals;
}

// Fingerprint of the last tick's signal set, for the change-detection gate in
// tick(). null until the first triage runs, so the first non-empty tick always
// triages. In-memory only: a restart re-triages once, which is harmless.
let lastSignalsFingerprint = null;

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

// Watch the live Models API for newer models in each tier's family and tell the
// owner when one ships (so the one-line config bump can be made deliberately).
// Slow cadence (default weekly). DETECT + NOTIFY by default: swapping the model a
// household runs on shifts cost/behavior, so it's a human decision. Set
// COS_MODEL_AUTOUPDATE=true to also apply the newest tiers to THIS process at
// runtime (until restart / config edit). The check timestamp AND the notify
// de-dup key are PERSISTED (model-notify-state.json) so the same release is
// pinged once total — not once per daemon restart (the in-memory version
// re-emailed on every boot, which is the bug this fixes).
const MODEL_CHECK_INTERVAL_MS = Number(process.env.MODEL_CHECK_INTERVAL_MS || 7 * 24 * 60 * 60 * 1000);
async function maybeCheckModelUpdates() {
  const now = Date.now();
  const state = await getModelNotifyState();
  if (now - state.lastCheckAt < MODEL_CHECK_INTERVAL_MS) return;
  try {
    const { tiers, changes, ok } = await discoverModelTiers();
    if (!ok) return; // API hiccup: don't advance lastCheckAt, retry next tick
    const autoupdate = String(process.env.COS_MODEL_AUTOUPDATE).toLowerCase() === "true";
    if (changes.length && autoupdate) {
      Object.assign(MODELS, tiers); // runtime-only; config.js stays the source of truth
      log.info("model tiers auto-updated", { tiers });
    }
    const key = changes.length ? changeKey(changes) : null;
    const next = { lastCheckAt: now, notifiedKey: key ?? state.notifiedKey };
    if (key && key !== state.notifiedKey) {
      const lines = changes.map((c) => `${c.tier}: ${c.from} -> ${c.to}`).join("\n");
      const verb = autoupdate
        ? "Applied for now; make it permanent in config.js"
        : "Consider bumping the tiers in config.js";
      await notifyOwner(`New Claude model(s) available:\n${lines}\n\n${verb}.`);
    }
    await setModelNotifyState(next);
  } catch (err) {
    log.error("model update check failed", { reason: err.message });
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

// Proactive shipment scan: on a slow cadence, read recent inbox mail (bodies) and
// record any tracking numbers, so packages are tracked hands-off even though the
// carrier's no-reply emails never reach the chief. Silent by design (no owner ping
// per shipment — that would be noisy); the family sees packages via the dashboard /
// "what's on the way?". processShipmentEmail is idempotent, so re-seeing the same
// mail each scan is a no-op. Best-effort; a Graph hiccup never sinks the tick.
let lastShipmentScanAt = 0;
const SHIPMENT_SCAN_INTERVAL_MS = Number(process.env.SHIPMENT_SCAN_INTERVAL_MS || 30 * 60 * 1000); // 30 min
async function maybeScanShipments() {
  const now = Date.now();
  if (now - lastShipmentScanAt < SHIPMENT_SCAN_INTERVAL_MS) return;
  lastShipmentScanAt = now;
  try {
    let tracked = 0, delivered = 0;
    for (const m of await recentShipmentMail({ top: 25 })) {
      if (isSelfAddress(m.from)) continue; // never act on our own outbound
      if (!isShippingEmail(m.subject, m.body) && !isDeliveryConfirmation(m.subject, m.body)) continue;
      const r = await processShipmentEmail({ subject: m.subject, body: m.body });
      tracked += r.tracked.length;
      delivered += r.delivered.length;
    }
    if (tracked || delivered) log.info("shipment scan recorded", { tracked, delivered });
  } catch (err) {
    log.error("shipment scan failed", { reason: err.message });
  }
}

// Propose a calendar pickup event for any package sent to a pickup location (UPS
// Store / locker / hold) that we haven't scheduled yet. We delegate to Lloyd so he
// can read the right person's calendar and slot it intelligently: Shelli's packages
// are ASAP (soonest open slot), Nic's fit into his next convenient free time. The
// event is CREATED through the confirmation gate (create_calendar stages an
// approval), so nothing lands on the calendar without a YES. Marked proposed once
// so it isn't re-suggested every tick. Runs cheaply: only spends tokens when a NEW
// pickup package is waiting.
async function maybeSchedulePickups() {
  let pending = [];
  try {
    pending = await listPickupsNeedingSchedule();
  } catch (err) {
    log.error("pickup list failed", { reason: err.message });
    return;
  }
  for (const p of pending) {
    const who = p.owner === "shelli" ? "Shelli" : "Nic";
    const urgency =
      p.owner === "shelli"
        ? "This is SHELLI'S package, so treat it as high priority: schedule the pickup ASAP — the soonest open slot, today if the location is still open."
        : "This is NIC'S package: fit the pickup into his next convenient free slot; do not disrupt existing plans.";
    try {
      // Lloyd reads the calendar and stages a pickup event via create_calendar
      // (which routes through the confirmation gate). We mark it proposed after,
      // so a denied/edited proposal isn't nagged again automatically.
      await runChief(
        `A package is ready for pickup and needs a calendar event for ${who}.\n` +
          `Package: ${p.description || p.carrier} (${p.carrier} ${p.trackingNumber}).\n` +
          `Pickup location: ${p.location || "the carrier's pickup location"}.\n` +
          `${urgency}\n` +
          `Use list_calendar to find ${who}'s free time, then create_calendar to propose a ~30 min ` +
          `event titled "Pick up package - ${p.location || p.carrier}" during plausible store hours. ` +
          `It will go through approval; do not claim it is booked.`,
        MODELS.standard
      );
      await markPickupScheduled(p.trackingNumber);
      log.info("pickup proposed", { tracking: p.trackingNumber, owner: p.owner, location: p.location });
    } catch (err) {
      log.error("pickup scheduling failed", { tracking: p.trackingNumber, reason: err.message });
    }
  }
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

// Frank's network monitor (PULL). Frank's own launchd scan (deploy/security/
// netscan.mjs) writes new-device findings to HIS local store; this asks him for
// them over the LAN delegate and alerts the owner. Detection stays on Frank,
// outbound stays on Lloyd (hard constraint 2) - Frank only RETURNS text.
// notifyOwner (not the confirmation gate), same as maybeSecurityScan: this informs
// the owner, it does not act on the family's behalf. Inert unless security is wired
// remote (no COS_SPECIALIST_URL_SECURITY => runs in-process, no netscan findings).
let lastNetScanAt = 0;
const NET_SCAN_INTERVAL_MS = Number(process.env.NETWORK_SCAN_INTERVAL_MS || 60 * 60 * 1000);
async function maybeNetworkScan() {
  if (chooseTransport("security") !== "remote") return; // only when Frank runs remote
  const now = Date.now();
  if (now - lastNetScanAt < NET_SCAN_INTERVAL_MS) return;
  lastNetScanAt = now;
  try {
    // Zero-model read (was an hourly Sonnet agent loop just to read Frank's JSON
    // store — and it was broken: delegate returns {text,requests}, so the old
    // `text.split` threw every tick). The op runs on Frank's side, so his findings
    // never leave his machine; Lloyd only surfaces the alert (notifyOwner, not the
    // confirmation gate — informing, not acting on the family's behalf).
    const { data } = await delegate({
      agent: "security",
      op: "list_findings",
      args: { status: "open", titlePrefix: "New device on LAN" },
    });
    const findings = Array.isArray(data) ? data : [];
    if (!findings.length) return;
    const lines = findings.map((f) => String(f?.title || "").trim()).filter(Boolean);
    // Persisted dedup + dismiss (heartbeat-alerts), same as the other proactive
    // alerts: survives restarts, so a lingering OPEN finding isn't re-alerted on
    // every reboot, and a device the family dismissed stays quiet. (This was an
    // in-memory Set, so each daemon restart re-fired every open device finding.)
    const fresh = [];
    for (const l of lines) if (await shouldAlert(l)) fresh.push(l);
    if (!fresh.length) return;
    for (const l of fresh) await recordAlerted(l);
    await notifyOwner(`Frank flagged new device(s) on the network:\n${fresh.join("\n")}\nReview and confirm they're expected. Say "that's expected" to dismiss.`);
    log.info("network scan surfaced", { newDevices: fresh.length });
  } catch (err) {
    log.error("network scan surface failed", { reason: err.message });
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
  // Claim the day ONLY after a successful delivery (not before): an empty
  // composition or an all-channels-failed send leaves the date unset so the next
  // tick retries within the window, instead of silently burning the day (the
  // 2026-07-01 sonnet-5 empty-digest incident). The persisted state makes a
  // same-tick double-fire the only (tiny) risk, far better than a silent no-digest.
  let r;
  try {
    r = await runMorningDigest();
  } catch (err) {
    log.error("morning digest failed", { reason: err.message });
    r = { delivered: false };
  }
  if (r.delivered) {
    await setLastDigestDate(date);
    log.info("morning digest sent", { date });
    return;
  }
  // Not delivered: don't claim the day (retry next tick), and alert the owner ONCE
  // per day so a persistent failure is never silent.
  log.warn("morning digest not delivered; will retry this window", { date, empty: !!r.empty });
  if ((await getDigestAlertedDate()) !== date) {
    await setDigestAlertedDate(date);
    await notifyOwner(`Heads up from Lloyd: I couldn't get this morning's digest out just now${r.empty ? " (it composed empty)" : ""}. I'll retry shortly; if it keeps failing, the standard model or a specialist may be down.`).catch(() => {});
  }
}

// Finance: drain queued transaction alerts into the spend log once per local day
// (one Haiku batch + reconcile pass), and deliver the weekly report on Sunday
// night. Both guards are persisted like the digest so restarts don't re-fire.
// Bank/card alert emails are "automated" senders, so the front door never enqueues
// them to the cos queue - they only land in the cos mailbox. Scan the inbox on a
// slow cadence and queue any transaction alerts directly for the daily ingest (same
// approach as maybeScanShipments). Deduped, so re-scanning is a no-op. Gated on
// ingest being enabled. Best-effort; a Graph hiccup never sinks the tick.
let lastAlertScanAt = 0;
const ALERT_SCAN_INTERVAL_MS = Number(process.env.FINANCE_ALERT_SCAN_INTERVAL_MS || 30 * 60 * 1000); // 30 min
async function maybeScanTransactionAlerts() {
  if (!FINANCE_REPORT.ingestEnabled) return;
  const now = Date.now();
  if (now - lastAlertScanAt < ALERT_SCAN_INTERVAL_MS) return;
  lastAlertScanAt = now;
  try {
    // Window must exceed how many inbox messages can arrive between scans, or
    // alerts scroll past unseen on a busy mailbox (root cause of a June 2026
    // capture gap). Default 100; raise FINANCE_ALERT_SCAN_TOP for heavier inboxes.
    const mails = await recentShipmentMail({ top: Number(process.env.FINANCE_ALERT_SCAN_TOP || 100) });
    // Statement notices and per-transaction alerts come from the same senders;
    // route statements to balance capture and the rest to the transaction queue so
    // a statement email is not mis-ingested as a charge.
    const statements = mails.filter((m) => isCreditStatement(m));
    const charges = mails.filter((m) => !isCreditStatement(m));
    const s = await scanInboxForStatements(statements);
    if (s.captured) log.info("credit statement captured", s);
    const r = await scanInboxForAlerts(charges);
    if (r.queued) log.info("transaction alerts queued from inbox", r);
  } catch (err) {
    log.error("transaction alert scan failed", { reason: err.message });
  }
}

// Self-healing inbound EMAIL reconcile: the daemon's own safety net so email
// intake does not depend on the legacy Azure front door (webhook drops were
// silently losing family emails). Reads the cos mailbox each tick and enqueues
// any not-yet-seen family email in the front-door envelope. First run baselines
// (enqueues nothing), so this never replays already-answered history. Best-effort.
async function maybeReconcileInboundEmail() {
  // Retired on the mini when the Azure front door (email-handler webhook +
  // cloud email-reconciler) owns inbound email. Its local dedup is disjoint from
  // the webhook cosinboundseen table, so running both double-enqueues -> double
  // replies. Set COS_EMAIL_RECONCILE_ENABLED=false to retire it here.
  if (String(process.env.COS_EMAIL_RECONCILE_ENABLED).toLowerCase() === "false") return;
  try {
    const r = await reconcileInboundEmail({ top: 25 });
    if (r.enqueued) log.info("inbound email reconciled to queue", r);
  } catch (err) {
    log.error("inbound email reconcile failed", { reason: err.message });
  }
}

async function maybeRunFinanceIngest() {
  if (!FINANCE_REPORT.ingestEnabled) return;
  const { date, hour } = localParts(new Date(), FINANCE_REPORT.tz);
  if (hour < FINANCE_REPORT.ingestHour || hour >= FINANCE_REPORT.ingestHour + 3) return;
  const last = await getLastIngestDate();
  if (last === date) return;
  await setLastIngestDate(date);
  try {
    const r = await buildDailyIngest();
    if (r.alerts) log.info("finance ingest", { date, alerts: r.alerts, logged: r.logged, flagged: r.flagged.length });
  } catch (err) {
    log.error("finance ingest failed", { reason: err.message });
  }
}

async function maybeRunFinanceReport() {
  if (!FINANCE_REPORT.enabled) return;
  const last = await getLastReportDate();
  const { run, date } = shouldRunWeeklyReport(new Date(), last, FINANCE_REPORT);
  if (!run) return;
  await setLastReportDate(date); // persist BEFORE running so a restart mid-run can't double-fire
  try {
    await runWeeklyFinanceReport();
    log.info("weekly finance report sent", { date });
  } catch (err) {
    log.error("weekly finance report failed", { reason: err.message });
  }
}

// Week-ahead scheduling-conflict scan (tracker 004): Sunday evening, once per day,
// persisted like the finance report. Surfacing only (notifyOwner), never the gate.
// Prepared-food leftovers -> next-day plan. For fresh prepared-food receipts, estimate
// servings vs headcount (3 family + guests the calendar shows that day); if there are
// likely leftovers and NO guest event, ask Carmine to adjust the NEXT day's plan. Each
// receipt is examined once (marked processed) so a sitting receipt can't re-notify.
// Itemize captured receipts (one cheap Haiku call over the un-extracted ones) into
// line items + a precise serving count. Runs BEFORE the leftover pass so leftovers
// use real entree counts, not the total/$16 estimate. Only fires when work is pending.
async function maybeExtractReceipts() {
  try {
    const pending = await pendingExtraction({ limit: 12 });
    if (!pending.length) return;
    const rows = pending.map((r) => ({ id: r.id, from: r.from, subject: r.subject, body: r.bodyText }));
    const { updates, unparsed } = await extractReceipts(rows);
    const n = await applyExtraction(updates, unparsed);
    log.info("receipts itemized (Haiku)", { extracted: n, unparsed: unparsed.length });
  } catch (err) {
    log.error("receipt itemization failed", { reason: err.message });
  }
}

async function maybeFactorLeftovers() {
  try {
    const prepared = (await listReceipts({ sinceDays: 2, kind: "prepared" })).filter((r) => !r.leftoverProcessed);
    if (!prepared.length) return;
    const events = await listEvents({ days: 2, back: 2 });
    const hits = [];
    for (const r of prepared) {
      const est = leftoverEstimate({ receipt: r, events });
      if (est.likely) hits.push(`${r.vendor} on ${r.date} (~${est.servings} servings, ~${est.leftovers} likely leftover)`);
    }
    await markLeftoverProcessed(prepared.map((r) => r.id)); // examined -> don't re-check
    if (!hits.length) return;
    await delegate({
      agent: "chef",
      task: `Prepared-food orders that likely left leftovers (family of 3, no guests on the calendar those days): ${hits.join("; ")}. Adjust the NEXT day's meal plan to use them up -- plan lighter or slot "leftovers from <vendor>". If the calendar shows guests that day, disregard.`,
    });
    log.info("leftover factoring delegated to chef", { orders: hits.length });
  } catch (err) {
    log.error("leftover factoring failed", { reason: err.message });
  }
}

async function maybeRunWeekConflicts() {
  if (!WEEK_CONFLICTS.enabled) return;
  const last = await getLastConflictRun();
  const { run, date } = shouldRunWeekConflicts(new Date(), last, WEEK_CONFLICTS);
  if (!run) return;
  await setLastConflictRun(date); // persist BEFORE running so a restart mid-run can't double-fire
  try {
    const n = await runWeekAheadConflicts();
    log.info("week-ahead conflict scan ran", { date, conflicts: n });
  } catch (err) {
    log.error("week-ahead conflict scan failed", { reason: err.message });
  }
}

// Monthly transfer outlook (Patrick): a few days before the 1st, compute the
// once-a-month joint-checking transfer from the live transaction feed (balance
// ledger + this cycle's credit charges + recorded bills/paycheck) and surface it
// to the owner. Once per cycle, persisted so restarts in the window don't re-fire.
// Off-switch: TRANSFER_OUTLOOK_ENABLED=false. Surfacing only; a human transfers.
async function maybeRunTransferOutlook() {
  if (String(process.env.TRANSFER_OUTLOOK_ENABLED ?? "true").toLowerCase() !== "true") return;
  const last = await getLastOutlookCycle();
  const { run, cycle } = shouldRunTransferOutlook(new Date(), last);
  if (!run) return;
  await setLastOutlookCycle(cycle); // persist BEFORE running so a restart mid-window can't double-fire
  try {
    const o = await transferOutlook();
    await notifyOwner(`Monthly checking transfer outlook:\n${o.text}`);
    log.info("transfer outlook surfaced", { cycle, needsBalance: Boolean(o.needsBalance) });
  } catch (err) {
    log.error("transfer outlook failed", { reason: err.message });
  }
}

// Afternoon package-pickup digest: weekday 5:30pm, iMessage to the owner, listing
// what was delivered today to the UPS Store. Persisted once-per-day guard.
async function maybeRunPackageDigest() {
  if (!PACKAGE_DIGEST.enabled) return;
  const last = await getLastPackageDigestDate();
  const { run, date } = shouldRunPackageDigest(new Date(), last, PACKAGE_DIGEST);
  if (!run) return;
  await setLastPackageDigestDate(date); // persist BEFORE running so a restart mid-window can't double-fire
  try {
    const r = await runPackageDigest();
    if (r.sent) log.info("package pickup digest sent", { date, count: r.count });
  } catch (err) {
    log.error("package pickup digest failed", { reason: err.message });
  }
}

async function maybeRunAmazonDigest() {
  if (!AMAZON_DIGEST.enabled) return;
  const last = await getLastAmazonDigestDate();
  const { run, date } = shouldRunAmazonDigest(new Date(), last, AMAZON_DIGEST);
  if (!run) return;
  await setLastAmazonDigestDate(date); // persist BEFORE running so a restart mid-window can't double-fire
  try {
    const r = await runAmazonDigest();
    if (r.sent) log.info("amazon spend digest sent", { date, count: r.count });
    else log.info("amazon spend digest skipped", { date, signedIn: r.signedIn, count: r.count ?? 0 });
  } catch (err) {
    log.error("amazon spend digest failed", { reason: err.message });
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
        // delegate returns {text, requests} (workstream S step 2); a specialist
        // like resale emits no requests, so read its text.
        const { text: resText } = await delegate({
          agent: "resale",
          task: "Run all saved searches now (run_saved_searches) and report ONLY new matches since last time. If there are no new matches, reply with exactly: NONE",
        });
        if (resText && !/^\s*NONE\s*\.?\s*$/i.test(resText)) await notifyOwner(`New resale finds:\n${resText}`);
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
        // Archive-boutique feeds: read public curated-shop storefronts (Allison's
        // Archive, LAL Vintage, ...) via the LOCAL browser for NEW listings a web
        // search would miss. No login needed; seeds silently per shop on first run.
        let boutiqueNew = 0;
        try {
          const feeds = await runBoutiqueFeeds();
          boutiqueNew = feeds.reduce((n, r) => n + (r.newItems ? r.newItems.length : 0), 0);
          if (boutiqueNew) await notifyOwner(`Archive boutique new arrivals:\n${formatBoutiqueFeed(feeds)}`);
        } catch (e) {
          log.error("boutique feed failed", { reason: e.message });
        }
        // Price-watch: re-check watched listings via the LOCAL browser (Lloyd) and
        // flag any drops / target hits. Done here on Lloyd, not the remote resale.
        const flagged = await checkWatched();
        if (flagged.length) await notifyOwner(`Price drop:\n${formatWatchFlags(flagged)}`);
        // Browser-only saved-search sites (Poshmark/Depop/Grailed/TheRealReal):
        // the REMOTE (Azure) resale specialist has no browser, so its
        // run_saved_searches above only covered eBay + Brave. Pull the hunt list
        // back over the delegate seam and run the browser-only sites here on
        // Lloyd. Skipped when resale is LOCAL (the in-process specialist already
        // ran every site, so this would just duplicate it).
        let browserNew = 0;
        if (chooseTransport("resale") === "remote") {
          try {
            const hunts = await fetchHuntsViaDelegate(delegate);
            const browserRun = await runSavedSearches({ scope: "local", searches: hunts });
            browserNew = browserRun.reduce((n, r) => n + r.newHits.length, 0);
            if (browserNew) await notifyOwner(`New resale finds (browser sites):\n${formatSavedSearchRun(browserRun)}`);
          } catch (e) {
            log.error("local browser saved-search run failed", { reason: e.message });
          }
        }
        log.info("resale run complete", { slot: slot.label, priceFlags: flagged.length, firstLookNew: feedNew, boutiqueNew, browserNew });
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

// Autonomous COO tick (workstream S step 4): once per local day, run each COO's
// "review the company" pass and let it escalate actionable output as gated
// requests (fulfilled behind the confirmation gate via runCooReview). Ships dark
// (COO_REVIEW.enabled). Per-COO once-per-day guard is persisted so a restart in the
// window can't double-fire; an over-budget company is skipped inside runCooReview.
async function maybeRunCooReviews() {
  if (!COO_REVIEW.enabled) return;
  let state;
  try {
    state = await getReviewState();
  } catch (err) {
    log.error("coo review state read failed", { reason: err.message });
    return;
  }
  for (const coo of cooRoster()) {
    if (!coo.reviewEnabled) continue; // step 5: per-company opt-in; only ready COOs run
    const { run, date } = shouldRunReview(new Date(), state[coo.key] || null, COO_REVIEW);
    if (!run) continue;
    await setReviewRan(coo.key, date); // persist BEFORE running so a restart mid-run can't double-fire
    try {
      const r = await runCooReview(coo, { delegate, requestConfirmation, budgetState });
      log.info("coo review", { coo: coo.key, ...r });
    } catch (err) {
      log.error("coo review failed", { coo: coo.key, reason: err.message });
    }
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
  await maybeReconcileInboundEmail();
  await maybeCheckCosts();
  await maybeCheckModelUpdates();
  await maybeBackup();
  await maybeScanShipments();
  await maybeSchedulePickups();
  await maybeSecurityScan();
  await maybeNetworkScan();
  await maybeRunDigest();
  await maybeScanTransactionAlerts();
  await maybeRunFinanceIngest();
  await maybeRunFinanceReport();
  await maybeRunWeekConflicts();
  await maybeExtractReceipts();
  await maybeFactorLeftovers();
  await maybeRunTransferOutlook();
  await maybeRunPackageDigest();
  await maybeRunAmazonDigest();
  await maybeFireReminders();
  await maybeRunResale();
  await maybeRunGroceryOrder();
  await maybeRunCooReviews();

  const signals = await gatherSignals();
  // Local gate: skip the Haiku triage call when the signal set is unchanged from
  // the last tick (the common case). Saves the program's most frequent model
  // call on quiet ticks and prevents re-escalating an unchanged signal. The
  // fingerprint is recorded only AFTER a successful triage, so a transient
  // triage failure still retries on the next identical tick.
  const fingerprint = signalsFingerprint(signals);
  if (fingerprint === lastSignalsFingerprint) {
    log.debug("heartbeat signals unchanged; skipped triage", { signals: signals.length });
    return;
  }
  const verdict = await triageHeartbeat(signals);
  lastSignalsFingerprint = fingerprint;
  if (!verdict.actionable) return;

  for (const item of verdict.items) {
    // Don't re-raise a proactive alert the family already dismissed, or one we just
    // sent within the TTL. This is what stops a "cleared" heads-up (e.g. an
    // acknowledged Amazon DSAR email) from re-firing every tick.
    if (!(await shouldAlert(item.what))) {
      log.info("proactive alert suppressed", { reason: "dismissed_or_recent", what: String(item.what).slice(0, 70) });
      continue;
    }
    if (item.urgency === "fyi") {
      await notifyOwner(`FYI: ${item.what}`);
      await recordAlerted(item.what);
      continue;
    }
    // Run the chief directly (triageHeartbeat already judged this, so no second
    // triage) and deliver the result to the owner. Previously this faked an
    // inbound SMS from "heartbeat", which threw in sendSms and dropped the result.
    try {
      // Urgency is about TIMING, not difficulty, so it no longer buys Opus — a
      // time-sensitive item isn't necessarily a hard one, and the proactive run
      // only stages any high-stakes action behind the gate. Sonnet handles these;
      // reserve Opus for genuinely complex inbound work (modelForComplexity).
      const result = await runChief(
        `Proactive task (${item.agent}, ${item.urgency}): ${item.what}`,
        MODELS.standard
      );
      await notifyOwner(`Proactive (${item.agent}, ${item.urgency}): ${result}`);
      await recordAlerted(item.what);
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
