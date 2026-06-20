import { randomUUID } from "node:crypto";
import { notifyOwner } from "./channels/twilio.js";

// ===========================================================================
// Human-in-the-loop gate. Any high-stakes action (sending mail/SMS on the
// family's behalf, a purchase, anything irreversible) must pass through here.
// requestConfirmation() texts the owner a summary + a code; the owner approves
// from their phone ("YES <code>") OR, if Slack is wired, by tapping an
// Approve/Deny button. Either path resolves the same pending code.
//
// Slack is added without an import cycle: slack.js calls registerApprovalNotifier()
// to receive each request, and resolveByCode() to resolve a button tap. confirm.js
// never imports slack.js.
// ===========================================================================

const pending = new Map(); // code -> { resolve, action, createdAt }
const notifiers = new Set(); // extra approval channels (e.g. Slack) -> fn({code, action})

/**
 * Register an extra approval notifier, called IN ADDITION to the SMS path so you
 * can approve from desk (Slack) or phone (SMS). Returns an unregister fn.
 */
export function registerApprovalNotifier(fn) {
  notifiers.add(fn);
  return () => notifiers.delete(fn);
}

/**
 * Ask the owner to approve an action. Returns a promise that resolves true/false.
 * Times out (default 30 min) to false so nothing hangs forever.
 */
export function requestConfirmation(actionDescription, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const code = randomUUID().slice(0, 4).toUpperCase();
  notifyOwner(
    `Approval needed:\n${actionDescription}\n\nReply "YES ${code}" to approve or "NO ${code}" to cancel.`
  );
  for (const n of notifiers) {
    // A broken notifier (e.g. Slack offline) must never block the SMS path.
    try {
      n({ code, action: actionDescription });
    } catch {
      /* ignore */
    }
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(code);
      resolve(false);
    }, timeoutMs);
    pending.set(code, {
      action: actionDescription,
      createdAt: Date.now(),
      resolve: (approved) => {
        clearTimeout(timer);
        pending.delete(code);
        resolve(approved);
      },
    });
  });
}

/**
 * Resolve a pending approval by its code (used by the Slack button action and,
 * underneath, the SMS parser). Returns true if a matching pending entry existed.
 */
export function resolveByCode(code, approved) {
  const entry = pending.get(String(code || "").toUpperCase());
  if (!entry) return false;
  entry.resolve(Boolean(approved));
  return true;
}

/**
 * SMS path: if the message is a "YES <code>" / "NO <code>" reply to a pending
 * action, resolve it and return true (so the orchestrator skips normal routing).
 */
export function tryResolveConfirmation(messageBody) {
  const m = /^\s*(yes|no)\s+([A-Za-z0-9]{4})\s*$/i.exec(messageBody || "");
  if (!m) return false;
  return resolveByCode(m[2], m[1].toLowerCase() === "yes");
}
