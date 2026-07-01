// RETIRED 2026-06-30. Twilio SMS is not an option for this assistant: the A2P /
// toll-free / long-code approval regime repeatedly rejected the use case, and the
// Twilio account has been closed. Every owner notification now goes through the
// live channels (email + Slack) in channels/notify.js. This module is kept only as
// a safe stub so any lingering import can't construct a Twilio client or make a
// call against the dead account — sendSms is a logged no-op. Do NOT reintroduce
// Twilio; the family text channel is iMessage (BlueBubbles).

import { createLogger } from "../log.js";

const log = createLogger("twilio");

/** Retired: never sends. Logged no-op so a stray caller degrades quietly. */
export async function sendSms(to, _body) {
  log.warn("sendSms is retired (Twilio closed) — dropping; use notify.js (email+Slack)", { to });
  return null;
}

export function notifyOwner(body) {
  return sendSms(undefined, body);
}
