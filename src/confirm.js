import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { notifyOwner } from "./channels/twilio.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Human-in-the-loop gate (hard constraint #2). Any high-stakes action — sending
// mail on the family's behalf, a purchase, a calendar invite — must pass through
// here. The action runs ONLY on an explicit approval.
//
// DEFERRED + PERSISTED by design:
//  - Deferred (non-blocking): the queue consumer is serial, so a confirmation
//    that blocked the turn awaiting "YES" dead-locked the daemon (the turn held
//    the consumer, so the reply could never be read). We stage and return a code
//    immediately; the turn ends; the reply resolves it later.
//  - Persisted: a staged action is stored by KIND + serializable PARAMS (NOT a
//    closure), so it survives a daemon restart — the nightly 4am restart used to
//    silently drop pending approvals. The orchestrator registers a handler per
//    kind at boot; resolving an approval dispatches to it.
//
// Slack is wired without an import cycle: slack.js registers a notifier and calls
// resolveByCode for button taps. confirm.js never imports slack.js or the
// orchestrator (handlers come in via registerActionHandler).
// ===========================================================================

const log = createLogger("confirm");

const PENDING_PATH = () => process.env.PENDING_APPROVALS_PATH || "./data/pending-approvals.json";
const TTL_MS = Number(process.env.APPROVAL_TTL_MS ?? 12 * 60 * 60 * 1000); // 12h: survive an overnight restart

const handlers = new Map(); // kind -> async (params) => resultString
const notifiers = new Set(); // extra approval channels (e.g. Slack) -> fn({code, action})

/** Register the executor for an action kind (called once at boot by the orchestrator). */
export function registerActionHandler(kind, fn) {
  handlers.set(kind, fn);
}

/** Register an extra approval notifier (e.g. Slack). Returns an unregister fn. */
export function registerApprovalNotifier(fn) {
  notifiers.add(fn);
  return () => notifiers.delete(fn);
}

// --- persisted pending store (prune expired on every read/write) ------------

async function loadPending(now = Date.now()) {
  let obj = {};
  try {
    obj = JSON.parse(await readFile(PENDING_PATH(), "utf8"));
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const [code, e] of Object.entries(obj || {})) {
    if (e && now - (e.createdAt || 0) <= TTL_MS) map.set(code, e);
  }
  return map;
}

async function savePending(map) {
  await mkdir(dirname(PENDING_PATH()), { recursive: true });
  await writeFile(PENDING_PATH(), JSON.stringify(Object.fromEntries(map), null, 2));
}

/**
 * Stage a high-stakes action for approval and return its code immediately (does
 * NOT block, persists across restarts). `kind` selects the registered executor;
 * `params` must be JSON-serializable and is passed to that executor on approval.
 * @returns {Promise<{code:string, instruction:string}>}
 */
export async function requestConfirmation(actionDescription, kind, params, { now = Date.now() } = {}) {
  if (!handlers.has(kind)) throw new Error(`no action handler registered for kind "${kind}"`);
  const code = randomUUID().slice(0, 4).toUpperCase();
  const pending = await loadPending(now);
  pending.set(code, { kind, params, action: actionDescription, createdAt: now });
  await savePending(pending);

  // SMS is best-effort (the code is also returned in-thread). Defer + catch so a
  // Twilio misconfig — sync OR async — can never break staging.
  Promise.resolve()
    .then(() => notifyOwner(`Approval needed:\n${actionDescription}\n\nReply "YES ${code}" to approve or "NO ${code}" to cancel.`))
    .catch(() => {});
  for (const n of notifiers) {
    try { n({ code, action: actionDescription }); } catch { /* a broken notifier must never block */ }
  }
  return { code, instruction: `Reply "YES ${code}" to confirm or "NO ${code}" to cancel.` };
}

/**
 * Resolve a pending approval by code. On approval, dispatches to the registered
 * handler for its kind and returns the result.
 * @returns {Promise<{found:boolean, approved?:boolean, action?:string, result?:string, error?:string}>}
 */
export async function resolveByCode(code, approved, { now = Date.now() } = {}) {
  const key = String(code || "").toUpperCase();
  const pending = await loadPending(now);
  const entry = pending.get(key);
  if (!entry) return { found: false };
  pending.delete(key);
  await savePending(pending);
  if (!approved) return { found: true, approved: false, action: entry.action };
  const handler = handlers.get(entry.kind);
  if (!handler) return { found: true, approved: true, action: entry.action, error: `no handler for "${entry.kind}"` };
  try {
    const result = await handler(entry.params);
    return { found: true, approved: true, action: entry.action, result: result || "Done." };
  } catch (err) {
    log.error("approved action failed", { reason: err.message, kind: entry.kind });
    return { found: true, approved: true, action: entry.action, error: err.message };
  }
}

/**
 * SMS path: if the message is a "YES <code>" / "NO <code>" reply, resolve it
 * (running the staged action on YES) and return a result to relay to the family.
 * `handled:false` means it was not an approval reply (normal routing continues).
 * @returns {Promise<{handled:boolean, message?:string}>}
 */
export async function tryResolveConfirmation(messageBody) {
  const raw = String(messageBody || "");
  // Strip quoted history / signature so an EMAIL reply ("YES 1234" above a quoted
  // thread, "On ... wrote:", "----", or "> ...") still parses as an approval.
  const head = raw.split(/\n\s*>|\nOn\b.+\bwrote:|\n-{2,}|\n_{2,}|\nSent from /i)[0].trim();
  // Approval replies are short. A long prose message that merely happens to
  // contain "yes" + a 4-char token is NOT an approval -> let it route normally.
  if (!head || head.length > 200) return { handled: false };

  // A 4-char code token (codes are uppercase hex) anywhere in the head, plus a
  // clear yes/no intent. Tolerates punctuation and a few extra words ("Yes, 1234
  // thanks", "approve 1234", "no 1234 cancel that").
  const code = (head.match(/\b([0-9a-f]{4})\b/i) || [])[1];
  const affirm = /\b(yes|yep|yeah|approve[d]?|confirm(?:ed)?|ok|okay|go ahead|do it|send it)\b/i.test(head);
  const negate = /\b(no|nope|deny|denied|cancel(?:led)?|don'?t|do not|stop|reject)\b/i.test(head);
  if (!code || (!affirm && !negate)) return { handled: false }; // not an approval reply

  const CODE = code.toUpperCase();
  if (affirm && negate) {
    return { handled: true, message: `Did you mean yes or no for code ${CODE}? Reply just "YES ${CODE}" or "NO ${CODE}".` };
  }
  const res = await resolveByCode(CODE, affirm);
  if (!res.found) {
    return { handled: true, message: `That approval code (${CODE}) is unknown or expired. Ask me again and I'll send a fresh one.` };
  }
  if (!affirm) return { handled: true, message: `Cancelled: ${res.action}` };
  if (res.error) return { handled: true, message: `I tried, but it failed: ${res.error}` };
  return { handled: true, message: res.result };
}
