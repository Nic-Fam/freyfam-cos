import twilio from "twilio";
import { TWILIO } from "../config.js";

const client = twilio(TWILIO.accountSid, TWILIO.authToken);

/**
 * Send an SMS. Prefers a Messaging Service (recommended for production:
 * sender pool, pumping protection, delivery features) and falls back to a
 * plain From number.
 */
export async function sendSms(to, body) {
  const opts = { to, body };
  if (TWILIO.messagingServiceSid) opts.messagingServiceSid = TWILIO.messagingServiceSid;
  else opts.from = TWILIO.from;
  const msg = await client.messages.create(opts);
  return msg.sid;
}

export function notifyOwner(body) {
  return sendSms(TWILIO.owner, body);
}
