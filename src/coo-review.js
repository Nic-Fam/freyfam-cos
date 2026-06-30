import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { COO_REVIEW } from "./config.js";
import { localParts } from "./digest.js";
import { delegate as realDelegate } from "./delegate.js";
import { requestConfirmation as realRequestConfirmation } from "./confirm.js";
import { fulfillCooRequests } from "./coo-requests.js";
import { budgetState as realBudgetState } from "./cost-ledger.js";
import { notifyOwner } from "./channels/notify.js"; // live owner channel (email + Slack); twilio SMS is retired
import { createLogger } from "./log.js";

const log = createLogger("coo-review");

// ===========================================================================
// Autonomous COO tick (TRACKER workstream S, step 4). On a daily cadence Lloyd
// runs each COO's "review the company" pass: the COO assesses where its company
// stands and emits gated REQUESTS for anything that needs to happen, which Lloyd
// fulfills behind his confirmation gate (reusing the step-2 request seam). This
// mirrors the existing heartbeat -> triage -> escalate loop, scoped per company.
//
// Spend is bounded two ways: a single review is a bounded agent loop, and an
// over-budget company is SKIPPED entirely (the per-COO ledger budget, step 3, is
// the runaway-spend guard). Ships dark; enable per company readiness.
// ===========================================================================

/** The scheduled review task handed to a COO. Kept deliberately lean + cheap. */
export function buildReviewPrompt(coo) {
  return [
    `This is your scheduled review of ${coo.company}. Briefly assess where the company stands and name the single most important next move.`,
    `Use your memory and decision log for context. If something concrete needs to happen, emit the right request: request_specialist for routine help from an allowed family specialist, request_heavy_lift for serious work by Nic, request_action for an outbound or spend.`,
    `Only emit a request when it is genuinely warranted - an early-stage company often just needs a short status and no action. Keep it to a few sentences and do not invent data you do not have.`,
  ].join("\n\n");
}

/**
 * Should this COO run its review now? True only inside [hour, hour+windowHours)
 * local AND not already run today. Mirrors shouldRunDigest. Pure + tested.
 */
export function shouldRunReview(now, lastRunDate, { hour = COO_REVIEW.hour, tz = COO_REVIEW.tz, windowHours = COO_REVIEW.windowHours } = {}) {
  const { date, hour: h } = localParts(now, tz);
  const inWindow = h >= hour && h < hour + windowHours;
  return { run: inWindow && lastRunDate !== date, date };
}

// Persisted per-COO last-run date (YYYY-MM-DD), so the once-per-day guard survives
// a restart inside the window (same lesson as the digest triple-fire).
const statePath = () => process.env.COO_REVIEW_STATE_PATH || "./data/coo-review-state.json";

export async function getReviewState() {
  try {
    const data = JSON.parse(await readFile(statePath(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}
export async function setReviewRan(cooKey, date) {
  const state = await getReviewState();
  state[cooKey] = date;
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(state, null, 2));
}

/**
 * Run one COO's review end to end: skip if over budget, else delegate the review,
 * fulfill the emitted requests behind the gate, and (optionally) surface the
 * review text to the owner. Deps are injectable for tests.
 * @returns {Promise<{ran:boolean, skipped?:string, company:string, requestCount?:number}>}
 */
export async function runCooReview(coo, {
  delegate = realDelegate,
  requestConfirmation = realRequestConfirmation,
  budgetState = realBudgetState,
  fulfill = fulfillCooRequests,
  notify = notifyOwner,
  notifyText = COO_REVIEW.notify,
  now = new Date(),
} = {}) {
  // Spend guard: an over-budget company pauses its autonomous reviews until the
  // cycle resets (the per-COO budget is the runaway-spend bound).
  const b = await budgetState(coo.companyKey, { now });
  if (b?.over) {
    log.info("coo review skipped (over budget)", { coo: coo.key, company: coo.companyKey });
    return { ran: false, skipped: "over-budget", company: coo.companyKey };
  }

  const res = await delegate({ agent: coo.key, task: buildReviewPrompt(coo) });
  const text = typeof res === "string" ? res : res?.text ?? "";
  const requests = res && Array.isArray(res.requests) ? res.requests : [];
  const summary = requests.length ? await fulfill(coo, requests, { delegate, requestConfirmation }) : "";

  // Quiet by default: gated requests already ping the owner via confirm.js, so we
  // only also surface the review text when explicitly asked (COO_REVIEW_NOTIFY).
  if (notifyText && (requests.length || text)) {
    await notify(`COO review (${coo.company}):\n${text}${summary ? `\n\n${summary}` : ""}`);
  }
  return { ran: true, company: coo.companyKey, requestCount: requests.length };
}
