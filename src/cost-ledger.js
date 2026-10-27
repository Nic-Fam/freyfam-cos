import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MODELS } from "./config.js";
import { companyKeyForAgent, companyByKey } from "./companies.js";
import { notifyOwner } from "./channels/notify.js"; // live owner channel (email+Slack); Twilio retired
import { createLogger } from "./log.js";

const log = createLogger("cost-ledger");

// ===========================================================================
// Per-COO cost ledger (TRACKER workstream S, step 3 / phase 1). The org-wide
// watchdog (cost.js) reads authoritative month-to-date $ from the Anthropic Admin
// API + Azure; that is the truth but it is coarse (no per-company attribution) and
// lags. This is the LOCAL, live early-warning layer: every COO-tier agent run is
// tagged with its company and its token usage is converted to an APPROXIMATE $ via
// a local price table, accumulated per company per cycle, and checked against that
// company's budget. Approximate by design (phase 2 swaps in per-COO Anthropic keys
// for authoritative attribution); good enough to warn before a company overspends.
//
// It records only COMPANY agents (a COO or a company specialist -> rolled up to its
// company). Family specialists and the chief are covered by the org-wide watchdog;
// metering a non-company agent here is a no-op.
// ===========================================================================

const LEDGER_PATH = () => process.env.COST_LEDGER_PATH || "./data/cost-ledger.json";
const FAMILY_TZ = process.env.FAMILY_TZ || "America/Los_Angeles";

// Local price table, USD per MILLION tokens. ESTIMATES for the early-warning
// ledger, not billing truth - override with COS_MODEL_PRICES (JSON) when rates
// change. cacheRead defaults to 0.10x of input (Opus 5.5 is 0.05x, so it is set
// explicitly). Cache WRITES are priced by the TTL actually used: 1.25x input for
// the 5-minute breakpoint and 2x for the 1-hour stable prefix (claude.js); the
// usage record carries both buckets when the API reports them. cacheWrite below
// is the 5m rate and is only used when the breakdown is absent.
// Refreshed 2026-10-11 from the current price list.
const DEFAULT_PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-8": { input: 5, output: 25 },
};
function loadPrices() {
  let overrides = {};
  if (process.env.COS_MODEL_PRICES) {
    try { overrides = JSON.parse(process.env.COS_MODEL_PRICES); } catch { log.warn("bad COS_MODEL_PRICES JSON; ignoring"); }
  }
  return { ...DEFAULT_PRICES, ...overrides };
}

/** Resolve a model's full price record, filling cache rates from input if absent. */
export function priceFor(model) {
  const table = loadPrices();
  const base = table[model] || table[MODELS.standard] || { input: 3, output: 15 };
  return {
    input: base.input,
    output: base.output,
    cacheWrite: base.cacheWrite ?? base.input * 1.25,     // 5m breakpoint
    cacheWrite1h: base.cacheWrite1h ?? base.input * 2,    // 1h stable prefix
    cacheRead: base.cacheRead ?? base.input * 0.1,
  };
}

/** Approximate USD for one run's aggregated usage (the {text,...,usage} from agentLoop). */
export function costOfUsage(model, usage = {}) {
  const p = priceFor(model);
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cr = usage.cache_read_input_tokens || 0;
  const cw1h = usage.cache_creation_1h_input_tokens || usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const cw5m = usage.cache_creation_5m_input_tokens || usage.cache_creation?.ephemeral_5m_input_tokens || 0;
  // Prefer the TTL breakdown; fall back to the aggregate at the 5m rate.
  const cwTotal = usage.cache_creation_input_tokens || 0;
  const cwCost = (cw1h || cw5m) ? cw1h * p.cacheWrite1h + cw5m * p.cacheWrite : cwTotal * p.cacheWrite;
  return (inTok * p.input + outTok * p.output + cwCost + cr * p.cacheRead) / 1e6;
}

/** Billing cycle key. Phase 1: calendar month (YYYY-MM) in the family timezone. */
export function cycleKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: FAMILY_TZ, year: "numeric", month: "2-digit" }).formatToParts(now);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  return `${y}-${m}`;
}

async function load() {
  try {
    const data = JSON.parse(await readFile(LEDGER_PATH(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
async function save(data) {
  await mkdir(dirname(LEDGER_PATH()), { recursive: true });
  await writeFile(LEDGER_PATH(), JSON.stringify(data, null, 2));
}

function emptyEntry() {
  return { spentUsd: 0, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, runs: 0, byModel: {}, alertedAt: null };
}

/**
 * Record one agent run's usage against its company's budget for the current cycle.
 * No-op (returns null) for a non-company agent. On the FIRST time a company crosses
 * its budget in a cycle, fires a one-time owner alert (best-effort; injectable).
 *
 * @returns {Promise<null | {company:string, cycle:string, spentUsd:number, budgetUsd:number|null, over:boolean, crossed:boolean}>}
 */
export async function recordUsage({ agent, model, usage } = {}, { now = new Date(), notify = notifyOwner } = {}) {
  const company = companyKeyForAgent(agent);
  if (!company) return null; // not a company agent -> covered by the org-wide watchdog
  const cost = costOfUsage(model, usage);
  const cycle = cycleKey(now);

  const ledger = await load();
  ledger[cycle] = ledger[cycle] || {};
  const entry = ledger[cycle][company] || emptyEntry();

  entry.spentUsd += cost;
  entry.tokens.input += usage?.input_tokens || 0;
  entry.tokens.output += usage?.output_tokens || 0;
  entry.tokens.cacheWrite += usage?.cache_creation_input_tokens || 0;
  entry.tokens.cacheRead += usage?.cache_read_input_tokens || 0;
  entry.runs += 1;
  const bm = entry.byModel[model] || { usd: 0, runs: 0 };
  bm.usd += cost;
  bm.runs += 1;
  entry.byModel[model] = bm;

  const budgetUsd = companyByKey(company)?.budgetUsd ?? null;
  const over = budgetUsd != null && entry.spentUsd >= budgetUsd;
  const crossed = over && !entry.alertedAt;
  if (crossed) entry.alertedAt = now.toISOString();

  ledger[cycle][company] = entry;
  await save(ledger);

  // Alert AFTER persisting, so a notify failure can't lose the crossing state. The
  // watchdog reuse: a single owner ping when a company first goes over for the cycle.
  // Best-effort: a broken notifier must never surface as a metering error.
  if (crossed) {
    try {
      await notify(`Budget alert: ${company} is over its ${cycle} budget (~$${entry.spentUsd.toFixed(2)} of $${budgetUsd}). Further COO work for it will keep spending unless paused.`);
    } catch { /* alert is best-effort */ }
  }
  return { company, cycle, spentUsd: entry.spentUsd, budgetUsd, over, crossed };
}

/** Current-cycle budget state for one company (for the soft cap / a dashboard). */
export async function budgetState(company, { now = new Date() } = {}) {
  const ledger = await load();
  const entry = ledger[cycleKey(now)]?.[company] || emptyEntry();
  const budgetUsd = companyByKey(company)?.budgetUsd ?? null;
  return {
    company,
    cycle: cycleKey(now),
    spentUsd: entry.spentUsd,
    budgetUsd,
    over: budgetUsd != null && entry.spentUsd >= budgetUsd,
    remaining: budgetUsd != null ? Math.max(0, budgetUsd - entry.spentUsd) : null,
  };
}

/** All companies' spend this cycle, for a status/dashboard view (step 4). */
export async function cycleSummary({ now = new Date() } = {}) {
  const ledger = await load();
  const cycle = cycleKey(now);
  const byCompany = ledger[cycle] || {};
  return Object.entries(byCompany).map(([company, e]) => ({
    company,
    cycle,
    spentUsd: e.spentUsd,
    budgetUsd: companyByKey(company)?.budgetUsd ?? null,
    runs: e.runs,
    over: (companyByKey(company)?.budgetUsd ?? Infinity) <= e.spentUsd,
  }));
}
