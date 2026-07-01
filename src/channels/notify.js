import { SLACK, OWNER_EMAIL } from "../config.js";
import { sendMail } from "./graph.js";
import { createLogger } from "../log.js";

// ===========================================================================
// Owner notification, Twilio-FREE (the family is off Twilio). Fans out to the
// channels that work today — Slack #command and email to the owner — and will
// gain iMessage once the BlueBubbles Private API helper is connected.
//
// CONTRACT: notifyOwner is BEST-EFFORT and NEVER throws. An outbound channel
// outage must never propagate into inbound message handling. A throwing
// notifyOwner (the old Twilio one, on a rejected credential) previously sank
// whole inbound emails: handleInbound awaited it, the throw bubbled up, the
// queue retried 5x and dead-lettered the family's message. Swallowing here makes
// that impossible — the worst case is a missed ping, never a lost message.
//
// Slack is wired WITHOUT an import cycle (same pattern as confirm.js): slack.js
// calls registerOwnerSlackNotifier() at startup, so this module never imports
// slack.js. Until that runs (or if Slack is disabled), email carries the ping.
// ===========================================================================

const log = createLogger("notify");

let slackNotifier = null; // (text) => Promise<unknown>, injected by slack.js at boot
export function registerOwnerSlackNotifier(fn) {
  slackNotifier = fn;
  return () => { if (slackNotifier === fn) slackNotifier = null; };
}

/**
 * Notify the owner across every live channel. Best-effort: resolves to "sent"
 * if at least one channel delivered, null otherwise. NEVER rejects.
 */
export async function notifyOwner(body) {
  const text = String(body ?? "");
  const tasks = [];
  if (slackNotifier) tasks.push(Promise.resolve().then(() => slackNotifier(text)));
  if (OWNER_EMAIL) {
    const subject = `Lloyd: ${text.split("\n")[0].slice(0, 80) || "notification"}`;
    tasks.push(Promise.resolve().then(() => sendMail({ to: OWNER_EMAIL, subject, body: text })));
  }
  if (!tasks.length) {
    log.warn("notifyOwner had no channel (Slack not registered, OWNER_EMAIL unset)");
    return null;
  }
  const results = await Promise.allSettled(tasks);
  const delivered = results.some((r) => r.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message || r.reason));
  if (failed.length) log.warn("notifyOwner channel(s) failed", { failed, anyDelivered: delivered });
  return delivered ? "sent" : null;
}

// Post ONLY to Slack (no email). For artifacts that are emailed separately to a
// recipient list (e.g. the morning digest -> DIGEST.emailTo) so we don't ALSO
// owner-email a duplicate copy. Best-effort: "sent" if Slack delivered, else null.
export async function postSlack(body) {
  if (!slackNotifier) return null;
  try { await slackNotifier(String(body ?? "")); return "sent"; }
  catch (e) { log.warn("slack post failed", { reason: String(e?.message || e) }); return null; }
}

// Slack approval/specialist channels live in channels/slack.js. SMS (channels/
// twilio.js) is retired; notifyOwner no longer touches it.
