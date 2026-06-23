import { IMESSAGE } from "../config.js";

// ===========================================================================
// Outbound iMessage via a self-hosted BlueBubbles server (BlueBubbles drives
// Messages.app on the Mac mini). This is the family-channel counterpart to
// channels/twilio.js: same shape (send text -> return a message id), but it
// reaches blue bubbles natively with no A2P registration, no per-message cost,
// and no carrier filtering. Twilio stays the fallback for non-Apple numbers.
//
// Reply by chatGuid when we have one (the inbound listener stamps it as
// `replyTo`): a chatGuid like "iMessage;-;+15551234567" pins the message to the
// EXACT existing thread, including group chats. With only a raw handle (a brand
// new 1:1), send by address and let BlueBubbles open/find the chat.
// ===========================================================================

// BlueBubbles "private-api" send mode is required for real iMessage sends
// (typing indicators, tapbacks, group sends). It needs the Private API helper
// enabled in the BlueBubbles server; without it, sends fail loudly here.
const SEND_METHOD = "private-api";

function isChatGuid(target) {
  const s = String(target || "");
  return s.startsWith("iMessage;") || s.startsWith("SMS;");
}

export async function sendImessage(target, body) {
  if (!IMESSAGE.enabled) {
    throw new Error("iMessage is not configured (set IMESSAGE_SERVER_URL + IMESSAGE_PASSWORD).");
  }
  const text = String(body ?? "");
  if (!target) throw new Error("sendImessage requires a target (chatGuid or handle).");

  const payload = isChatGuid(target)
    ? { chatGuid: target, message: text, method: SEND_METHOD }
    : { addresses: [String(target)], message: text, method: SEND_METHOD };

  const url = `${IMESSAGE.serverUrl}/api/v1/message/text?password=${encodeURIComponent(IMESSAGE.password)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`BlueBubbles send failed: ${res.status} ${detail}`.trim());
  }
  const json = await res.json().catch(() => ({}));
  return json?.data?.guid; // message guid, analogous to a Twilio message SID
}

export function notifyOwnerImessage(body) {
  // Owner's iMessage handle (phone/Apple ID). Falls back to no-op if unset so a
  // caller can prefer iMessage and degrade to the SMS notifyOwner elsewhere.
  const owner = process.env.OWNER_IMESSAGE || process.env.OWNER_PHONE;
  if (!owner) return Promise.resolve(null);
  return sendImessage(owner, body);
}
