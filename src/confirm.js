import { randomUUID } from "node:crypto";
import { notifyOwner } from "./channels/twilio.js";

// ===========================================================================
// Human-in-the-loop gate. Any high-stakes action (sending mail/SMS on the
// family's behalf, a purchase, anything irreversible) must pass through here.
// The agent calls requestConfirmation(); the daemon texts the owner a summary;
// the owner's "YES <code>" reply resolves the promise and the action proceeds.
// ===========================================================================

const pending = new Map(); // code -> { resolve, action, createdAt }

/**
 * Ask the owner to approve an action. Returns a promise that resolves true/false.
 * Times out (default 30 min) to false so nothing hangs forever.
 */
export function requestConfirmation(actionDescription, { timeoutMs = 30 * 60 * 1000 } = {}) {
  const code = randomUUID().slice(0, 4).toUpperCase();
  notifyOwner(
    `Approval needed:\n${actionDescription}\n\nReply "YES ${code}" to approve or "NO ${code}" to cancel.`
  );
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
 * Inspect an inbound message; if it is a YES/NO <code> reply to a pending
 * action, resolve it and return true (so the orchestrator skips normal routing).
 */
export function tryResolveConfirmation(messageBody) {
  const m = /^\s*(yes|no)\s+([A-Za-z0-9]{4})\s*$/i.exec(messageBody || "");
  if (!m) return false;
  const approved = m[1].toLowerCase() === "yes";
  const code = m[2].toUpperCase();
  const entry = pending.get(code);
  if (!entry) return false;
  entry.resolve(approved);
  return true;
}
