import { READ_ONLY_DOMAINS } from "./config.js";

export class OutboundBlockedError extends Error {}

function domainOf(addressOrList) {
  const list = Array.isArray(addressOrList) ? addressOrList : [addressOrList];
  return list
    .map((a) => String(a).toLowerCase())
    .map((a) => (a.includes("@") ? a.split("@").pop() : a))
    .map((d) => d.trim());
}

/**
 * Throws if any recipient is on a read-only domain. Call this in EVERY
 * outbound path (email send, and any future channel that can reach work inboxes).
 * This is a hard rule: the assistant reads Flyer Defense / Disney mail but never
 * replies, forwards, or sends to those domains.
 */
export function assertOutboundAllowed(recipients) {
  for (const dom of domainOf(recipients)) {
    if (READ_ONLY_DOMAINS.includes(dom)) {
      throw new OutboundBlockedError(
        `Refusing to send to read-only domain "${dom}". These addresses are inbound-only.`
      );
    }
  }
}
