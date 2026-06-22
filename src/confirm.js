import { randomUUID } from "node:crypto";
import { notifyOwner } from "./channels/twilio.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Human-in-the-loop gate. Any high-stakes action (sending mail/SMS on the
// family's behalf, a purchase, anything irreversible) must pass through here.
//
// DEFERRED, NON-BLOCKING by design. The queue consumer processes messages
// serially, so a confirmation that BLOCKED the turn awaiting a "YES" reply
// dead-locked the whole daemon: the turn held the consumer, so the approval
// reply could never be read to release it. Instead we STAGE the action and
// return immediately with a code; the turn ends, the consumer is free, and the
// "YES <code>" reply (SMS) or a Slack button executes the staged action then.
//
// The gate is still absolute: the action's `execute` only runs on an explicit
// approval. Staged actions live in memory, so a daemon restart drops anything
// not yet approved (the requester just re-asks) — acceptable and far better
// than a deadlock.
//
// Slack is wired without an import cycle: slack.js calls registerApprovalNotifier()
// to receive each request and resolveByCode() to resolve a button tap. confirm.js
// never imports slack.js.
// ===========================================================================

const log = createLogger("confirm");

const pending = new Map(); // code -> { action, execute, createdAt, timer }
const notifiers = new Set(); // extra approval channels (e.g. Slack) -> fn({code, action})

const DEFAULT_TTL_MS = 60 * 60 * 1000; // an approval is good for an hour

/**
 * Register an extra approval notifier, called IN ADDITION to the SMS path so you
 * can approve from desk (Slack) or phone (SMS). Returns an unregister fn.
 */
export function registerApprovalNotifier(fn) {
  notifiers.add(fn);
  return () => notifiers.delete(fn);
}

/**
 * Stage a high-stakes action for approval and return its code immediately (does
 * NOT block). The caller returns a message telling the family to reply
 * "YES <code>". `execute` is an async fn run only on approval; its return value
 * (a short status string) is delivered back to whoever approves.
 *
 * @param {string} actionDescription  human summary shown in the approval prompt
 * @param {() => Promise<string>} execute  the actual side effect, run on YES
 * @returns {{ code: string, instruction: string }}
 */
export function requestConfirmation(actionDescription, execute, { timeoutMs = DEFAULT_TTL_MS } = {}) {
  if (typeof execute !== "function") {
    throw new Error("requestConfirmation requires an execute() callback (deferred model)");
  }
  const code = randomUUID().slice(0, 4).toUpperCase();
  const timer = setTimeout(() => {
    if (pending.delete(code)) log.info("approval expired", { code });
  }, timeoutMs);
  if (timer.unref) timer.unref(); // never keep the process alive just for a pending approval
  pending.set(code, { action: actionDescription, execute, createdAt: Date.now(), timer });

  // SMS delivery is best-effort (the code is also returned in-thread). Defer +
  // catch so a Twilio misconfig — sync OR async — can never break staging.
  Promise.resolve()
    .then(() => notifyOwner(`Approval needed:\n${actionDescription}\n\nReply "YES ${code}" to approve or "NO ${code}" to cancel.`))
    .catch(() => {});
  for (const n of notifiers) {
    try { n({ code, action: actionDescription }); } catch { /* a broken notifier must never block */ }
  }

  return {
    code,
    instruction: `Reply "YES ${code}" to confirm or "NO ${code}" to cancel.`,
  };
}

/**
 * Resolve a pending approval by code. On approval, runs the staged action and
 * returns its result. Used by the Slack button and, underneath, the SMS parser.
 * @returns {Promise<{found:boolean, approved?:boolean, action?:string, result?:string, error?:string}>}
 */
export async function resolveByCode(code, approved) {
  const entry = pending.get(String(code || "").toUpperCase());
  if (!entry) return { found: false };
  clearTimeout(entry.timer);
  pending.delete(String(code || "").toUpperCase());
  if (!approved) return { found: true, approved: false, action: entry.action };
  try {
    const result = await entry.execute();
    return { found: true, approved: true, action: entry.action, result: result || "Done." };
  } catch (err) {
    log.error("approved action failed", { reason: err.message });
    return { found: true, approved: true, action: entry.action, error: err.message };
  }
}

/**
 * SMS path: if the message is a "YES <code>" / "NO <code>" reply to a pending
 * action, resolve it (running the action on YES) and return a result the caller
 * can relay to the family. `handled:false` means it was not an approval reply,
 * so normal routing should continue.
 * @returns {Promise<{handled:boolean, message?:string}>}
 */
export async function tryResolveConfirmation(messageBody) {
  const m = /^\s*(yes|no)\s+([A-Za-z0-9]{4})\s*$/i.exec(messageBody || "");
  if (!m) return { handled: false };
  const approved = m[1].toLowerCase() === "yes";
  const res = await resolveByCode(m[2], approved);
  if (!res.found) {
    return { handled: true, message: `That approval code (${m[2].toUpperCase()}) is unknown or expired. Ask me again and I'll send a fresh one.` };
  }
  if (!approved) return { handled: true, message: `Cancelled: ${res.action}` };
  if (res.error) return { handled: true, message: `I tried, but it failed: ${res.error}` };
  return { handled: true, message: res.result };
}
