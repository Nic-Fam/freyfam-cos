import twilio from "twilio";
import { TWILIO } from "../config.js";

const client = twilio(TWILIO.accountSid, TWILIO.authToken);

/**
 * Send an SMS. Prefers a Messaging Service (recommended for production:
 * sender pool, pumping protection, delivery features) and falls back to a
 * plain From number.
 */
// Twilio rejects a single request body over 1600 chars. Truncate so a long
// proactive result / digest still delivers (the full version also goes by email).
const SMS_MAX = 1590;

export async function sendSms(to, body) {
  let text = String(body ?? "");
  if (text.length > SMS_MAX) text = text.slice(0, SMS_MAX - 1) + "…";
  const opts = { to, body: text };
  if (TWILIO.messagingServiceSid) opts.messagingServiceSid = TWILIO.messagingServiceSid;
  else opts.from = TWILIO.from;
  const msg = await client.messages.create(opts);
  return msg.sid;
}

export function notifyOwner(body) {
  return sendSms(TWILIO.owner, body);
}
