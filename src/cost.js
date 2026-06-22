// ===========================================================================
// Cost watchdog. Two independent spend meters, both read with plain API calls
// (NO model tokens), checked on a throttled cadence from the heartbeat:
//
//   - Anthropic Console: month-to-date USD via the Admin "cost_report" endpoint.
//   - Azure: month-to-date USD via the Cost Management "query" endpoint.
//   - Brave Search: no billing API exists, so we meter the queries this daemon
//     makes (src/search.js -> recordBraveQuery) and convert to overage cost.
//
// When either crosses the alert threshold for the current billing cycle we text
// the owner ONCE (via the guarded Twilio path), then re-alert at each further
// step so a runaway bill keeps pinging instead of going quiet after the first
// hit. State is a tiny local JSON file so we never spam on every tick.
//
// "Cycle" = calendar month in UTC. Anthropic bills per calendar month; standard
// Azure pay-as-you-go subscriptions reset on the 1st too. If your Azure billing
// period is offset, set COST_CYCLE_DAY (1-28) to the day your cycle starts.
// ===========================================================================

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ClientSecretCredential } from "@azure/identity";
import { COST, MODELS, ANTHROPIC_API_KEY } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("cost");

// --- "cycle" helpers --------------------------------------------------------

/** The RFC-3339 UTC instant the current billing cycle started. */
export function cycleStart(now = new Date(), cycleDay = COST.cycleDay) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const day = now.getUTCDate();
  // If we're before the cycle day this month, the cycle started last month.
  const startMonth = day >= cycleDay ? m : m - 1;
  return new Date(Date.UTC(y, startMonth, cycleDay, 0, 0, 0));
}

/** Stable per-cycle key, e.g. "2026-06", used to scope the alert state. */
export function cycleKey(now = new Date(), cycleDay = COST.cycleDay) {
  const start = cycleStart(now, cycleDay);
  return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
}

// --- pure threshold logic (unit-tested) -------------------------------------

/**
 * Which alert tier a spend level has reached.
 *   0           -> under threshold, no alert
 *   1           -> crossed the threshold (e.g. $100)
 *   2, 3, ...    -> crossed threshold + N*step (e.g. $150, $200 with step $50)
 */
export function tierFor(spendUsd, threshold = COST.thresholdUsd, step = COST.stepUsd) {
  if (spendUsd < threshold) return 0;
  if (step <= 0) return 1;
  return 1 + Math.floor((spendUsd - threshold) / step);
}

/** The dollar floor of a tier, for human-readable messaging. */
export function tierFloorUsd(tier, threshold = COST.thresholdUsd, step = COST.stepUsd) {
  return tier <= 0 ? 0 : threshold + (tier - 1) * step;
}

// --- alert state (so we notify once per tier, per cycle) --------------------

async function loadState() {
  try {
    return JSON.parse(await readFile(COST.statePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function saveState(state) {
  await mkdir(dirname(COST.statePath), { recursive: true });
  await writeFile(COST.statePath, JSON.stringify(state, null, 2));
}

// --- spend readers ----------------------------------------------------------

/**
 * Anthropic Console month-to-date spend in USD.
 * Admin API "cost_report" returns amounts in the lowest currency unit (cents)
 * as decimal strings; we sum across every bucket + line item and convert.
 * Requires an Admin API key (sk-ant-admin..., distinct from the inference key).
 */
export async function anthropicMonthToDateUsd(now = new Date()) {
  if (!COST.anthropicAdminKey) return null;
  const params = new URLSearchParams({
    starting_at: cycleStart(now).toISOString(),
    bucket_width: "1d",
  });
  let cents = 0;
  let page;
  do {
    if (page) params.set("page", page);
    const res = await fetch(
      `https://api.anthropic.com/v1/organizations/cost_report?${params}`,
      {
        headers: {
          "x-api-key": COST.anthropicAdminKey,
          "anthropic-version": "2023-06-01",
        },
      }
    );
    if (!res.ok) {
      throw new Error(`Anthropic cost_report ${res.status}: ${await res.text()}`);
    }
    const body = await res.json();
    for (const bucket of body.data || []) {
      for (const item of bucket.results || []) {
        cents += Number(item.amount) || 0;
      }
    }
    page = body.has_more ? body.next_page : null;
  } while (page);
  return cents / 100;
}

/**
 * Azure month-to-date actual spend in USD (pre-tax) for the configured
 * subscription. Uses a service principal with the "Cost Management Reader"
 * role and the Cost Management query endpoint.
 */
export async function azureMonthToDateUsd() {
  const { tenantId, clientId, clientSecret, subscriptionId } = COST.azure;
  if (!(tenantId && clientId && clientSecret && subscriptionId)) return null;

  const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
  const { token } = await cred.getToken("https://management.azure.com/.default");

  const url =
    `https://management.azure.com/subscriptions/${subscriptionId}` +
    `/providers/Microsoft.CostManagement/query?api-version=2025-03-01`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "ActualCost",
      timeframe: "MonthToDate",
      dataset: {
        granularity: "None",
        aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } },
      },
    }),
  });
  if (res.status === 204) return 0; // no usage yet this cycle
  if (!res.ok) throw new Error(`Azure cost query ${res.status}: ${await res.text()}`);

  const body = await res.json();
  const cols = (body.properties?.columns || []).map((c) => c.name);
  const costIdx = cols.indexOf("PreTaxCost");
  let total = 0;
  for (const row of body.properties?.rows || []) {
    total += Number(row[costIdx]) || 0;
  }
  return total;
}

// --- Anthropic credit-balance health -----------------------------------------
// There is no public "remaining balance" endpoint, so we detect the failure that
// actually matters: when the API rejects calls because credits are exhausted/too
// low (a 400 invalid_request_error mentioning the credit balance). A silent
// version of this took the daemon down — every agent run failed but nothing told
// the owner. A tiny 1-token ping turns that into an immediate, actionable alert.
// fetchImpl injectable for tests.
export async function anthropicCreditStatus({ fetchImpl = fetch } = {}) {
  if (!ANTHROPIC_API_KEY) return { ok: true }; // not configured -> nothing to check
  let res;
  try {
    res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODELS.triage, max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
    });
  } catch {
    return { ok: true }; // network blip is not a balance problem; don't false-alarm
  }
  if (res.ok) return { ok: true };
  let body = "";
  try { body = await res.text(); } catch { /* ignore */ }
  // Credit/billing problems read as "credit balance is too low" / payment / billing.
  if (/credit balance|too low|billing|payment required|insufficient/i.test(body) || res.status === 402) {
    return { ok: false, reason: "Anthropic API credit balance is too low" };
  }
  return { ok: true }; // other errors (rate limit, 500) are not a balance signal
}

// --- Brave Search overage (metered locally; no Brave billing API) -----------

async function loadUsage() {
  try {
    return JSON.parse(await readFile(COST.brave.usagePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function saveUsage(usage) {
  await mkdir(dirname(COST.brave.usagePath), { recursive: true });
  await writeFile(COST.brave.usagePath, JSON.stringify(usage, null, 2));
}

/**
 * Count Brave queries made this cycle. Called from src/search.js on every
 * successful search. Never throws into the caller — metering must not break
 * search; it just logs and moves on. No-op when the Brave meter is disabled.
 */
export async function recordBraveQuery(now = new Date(), n = 1) {
  if (!COST.brave.enabled) return;
  try {
    const key = cycleKey(now);
    const usage = await loadUsage();
    usage[key] = (usage[key] || 0) + n;
    await saveUsage(usage);
  } catch (err) {
    log.error("brave usage record failed", { reason: err.message });
  }
}

export async function braveQueriesThisCycle(now = new Date()) {
  const usage = await loadUsage();
  return usage[cycleKey(now)] || 0;
}

/** Pure overage math: queries above the plan quota, billed per 1,000. */
export function braveOverageUsd(
  used,
  included = COST.brave.includedQueries,
  per1k = COST.brave.overageUsdPer1k
) {
  return (Math.max(0, used - included) / 1000) * per1k;
}

/** Month-to-date Brave overage in USD; null when the meter is disabled. */
export async function braveMonthToDateUsd(now = new Date()) {
  if (!COST.brave.enabled) return null;
  return braveOverageUsd(await braveQueriesThisCycle(now));
}

// --- the check the heartbeat calls ------------------------------------------

const SOURCES = {
  azure: { label: "Azure", read: () => azureMonthToDateUsd() },
  anthropic: { label: "Anthropic API", read: (now) => anthropicMonthToDateUsd(now) },
  brave: { label: "Brave Search overage", read: (now) => braveMonthToDateUsd(now) },
};

/**
 * Read both meters, compare to the threshold, and return the alert lines that
 * should be sent right now (only newly-crossed tiers). De-dupes via the local
 * state file, scoped to the current cycle, so each tier alerts at most once.
 */
export async function checkCostThresholds(now = new Date(), { notify } = {}) {
  const key = cycleKey(now);
  const state = await loadState();
  const cycle = (state[key] ||= {});
  const alerts = [];

  for (const [id, src] of Object.entries(SOURCES)) {
    let spend;
    try {
      spend = await src.read(now);
    } catch (err) {
      log.error("source read failed", { source: src.label, reason: err.message });
      continue;
    }
    if (spend == null) continue; // not configured

    const tier = tierFor(spend);
    const lastAlerted = cycle[id] || 0;
    if (tier > lastAlerted) {
      const floor = tierFloorUsd(tier);
      const verb = tier === 1 ? "has crossed" : "is still climbing past";
      const msg =
        `Cost alert: ${src.label} spend this cycle is $${spend.toFixed(2)}, ` +
        `which ${verb} the $${floor} mark. (cycle ${key})`;
      alerts.push(msg);
      cycle[id] = tier;
      if (notify) await notify(msg);
    }
  }

  let dirty = alerts.length > 0;

  // Credit-balance health (not cycle-scoped: an empty balance is urgent whenever it
  // happens). Alert the FIRST time we see it fail, then at most once per 24h while
  // still down; clear on recovery so the next outage alerts again.
  try {
    const credit = await anthropicCreditStatus();
    if (!credit.ok) {
      const last = state.creditAlertAt || 0;
      if (now.getTime() - last > 24 * 60 * 60 * 1000) {
        const msg = `Cost alert: ${credit.reason}. Lloyd cannot run until you add credits at console.anthropic.com/settings/billing.`;
        alerts.push(msg);
        state.creditAlertAt = now.getTime();
        dirty = true;
        if (notify) await notify(msg);
      }
    } else if (state.creditAlertAt) {
      delete state.creditAlertAt; // recovered -> reset so a future outage alerts again
      dirty = true;
    }
  } catch (err) {
    log.error("credit-balance check failed", { reason: err.message });
  }

  if (dirty) await saveState(state);
  return alerts;
}
