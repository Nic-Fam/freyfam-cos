// ===========================================================================
// Cost watchdog. Two independent spend meters, both read with plain API calls
// (NO model tokens), checked on a throttled cadence from the heartbeat:
//
//   - Anthropic Console: month-to-date USD via the Admin "cost_report" endpoint.
//   - Azure: month-to-date USD via the Cost Management "query" endpoint.
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
import { COST } from "./config.js";
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

// --- the check the heartbeat calls ------------------------------------------

const SOURCES = {
  azure: { label: "Azure", read: () => azureMonthToDateUsd() },
  anthropic: { label: "Anthropic API", read: (now) => anthropicMonthToDateUsd(now) },
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

  if (alerts.length) await saveState(state);
  return alerts;
}
