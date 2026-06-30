// Proactive owner notifications fan out to every LIVE channel, best-effort, so a
// single dead transport can never silently swallow a notice. This mirrors the
// approval-notifier registry in confirm.js (Slack + email register into it).
//
// Background: `notifyOwner` used to be Twilio SMS ONLY. With SMS retired and
// iMessage still pending the BlueBubbles bridge, every proactive heartbeat notice
// (cost alert, breach, OTP relay, outage, reminders, resale finds, FYIs...) was
// throwing into a swallowed catch and reaching no one. Now Slack and/or email
// register here at startup and notifyOwner delivers to whatever is live; SMS is
// still attempted (harmless once it's back).
//
// Cycle-safe like confirm.js: this leaf module imports only the SMS transport +
// config + logger. slack.js / graph.js import THIS and register, never the reverse.
import { TWILIO } from "./config.js";
import { notifyOwner as notifyOwnerSms } from "./channels/twilio.js";
import { createLogger } from "./log.js";

const log = createLogger("owner-notify");
const notifiers = new Set(); // live channels: { channel, fn({text, subject}) -> Promise }

/**
 * Register a live owner-notice channel (e.g. Slack, email). The fn receives
 * {text, subject} and SHOULD let its promise reject on failure (notifyOwner
 * records per-channel success/failure). Returns an unregister fn.
 */
export function registerOwnerNotifier(channel, fn) {
  const entry = { channel, fn };
  notifiers.add(entry);
  return () => notifiers.delete(entry);
}

/** Test helper: drop all registered notifiers. */
export function _clearOwnerNotifiers() {
  notifiers.clear();
}

// A short email-friendly subject when the caller doesn't supply one: the first
// line, trimmed. Keeps "Security: ... new breach" / "Reminder: ..." legible as a
// subject without each call site having to pass one.
function deriveSubject(body) {
  const first = String(body ?? "").split("\n").find((l) => l.trim()) || "Lloyd";
  return first.trim().slice(0, 80);
}

/**
 * Send a proactive notice to the owner over EVERY available channel, best-effort.
 * Each leg is independent (Promise.allSettled), so one channel failing never blocks
 * the others. Returns the list of channels that actually delivered.
 * @param {string} body
 * @param {{subject?:string}} [opts] subject is used by channels that need one (email)
 * @returns {Promise<string[]>} channels that delivered
 */
export async function notifyOwner(body, { subject } = {}) {
  const subj = subject || deriveSubject(body);
  const legs = [];
  // SMS only when an owner number is configured (skipped in tests / when retired-out).
  if (TWILIO.owner) legs.push({ channel: "sms", run: () => notifyOwnerSms(body) });
  for (const { channel, fn } of notifiers) legs.push({ channel, run: () => fn({ text: body, subject: subj }) });

  const results = await Promise.allSettled(legs.map((l) => Promise.resolve().then(l.run)));
  const delivered = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") delivered.push(legs[i].channel);
    else log.warn("owner notice channel failed", { channel: legs[i].channel, reason: String(r.reason?.message || r.reason) });
  });
  if (!delivered.length) log.error("owner notice reached no channel", { subject: subj });
  return delivered;
}
