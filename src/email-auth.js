// ===========================================================================
// Inbound EMAIL sender authentication (hard constraints #1 + #2).
//
// `guards.isAuthorizedSender` decides WHO may drive the chief or approve a staged
// action, but for email it only had the From header to go on, and From is
// trivially forged. A spoofed "From: nic@freyfam.com" with body "YES <code>" would
// otherwise approve a staged send/spend. The mailbox lives in Exchange Online,
// which stamps every delivered message with an Authentication-Results header
// carrying its SPF/DKIM/DMARC/composite-auth verdicts, so we read that header
// (via Graph `internetMessageHeaders`) and require a PASS before an email sender
// counts as authorized.
//
// Verdict rule (pure, tested): PASS when
//   - dmarc=pass            (the From domain is DKIM/SPF aligned: the normal case
//                            for gmail/outlook/corporate senders), OR
//   - compauth=pass         (Microsoft composite authentication, which also covers
//                            intra-tenant mail that carries no DKIM at all).
// Anything else (fail, none, missing header, fetch error) is NOT verified.
//
// EMAIL_AUTH_CHECK=false disables enforcement (logs a loud warning at boot);
// keep it on in production.
// ===========================================================================

import { createLogger } from "./log.js";

const log = createLogger("email-auth");

export const EMAIL_AUTH_ENFORCED =
  String(process.env.EMAIL_AUTH_CHECK ?? "true").toLowerCase() !== "false";

/**
 * Parse an Authentication-Results header (Exchange Online shape) into a verdict.
 * Pure. Accepts a string, an array of header values (Graph may return several),
 * or null/undefined.
 * @returns {{verified:boolean, reason:string, dmarc:string|null, compauth:string|null, dkim:string|null, spf:string|null}}
 */
export function authResultsVerdict(header) {
  const text = (Array.isArray(header) ? header : [header])
    .filter(Boolean)
    .map(String)
    .join("; ")
    .toLowerCase();
  if (!text.trim()) return { verified: false, reason: "no Authentication-Results header", dmarc: null, compauth: null, dkim: null, spf: null };
  const grab = (k) => {
    const m = text.match(new RegExp(`(?:^|[;\\s])${k}=([a-z]+)`));
    return m ? m[1] : null;
  };
  const dmarc = grab("dmarc");
  const compauth = grab("compauth");
  const dkim = grab("dkim");
  const spf = grab("spf");
  if (dmarc === "pass") return { verified: true, reason: "dmarc=pass", dmarc, compauth, dkim, spf };
  if (compauth === "pass") return { verified: true, reason: "compauth=pass", dmarc, compauth, dkim, spf };
  return {
    verified: false,
    reason: `dmarc=${dmarc || "none"} compauth=${compauth || "none"} dkim=${dkim || "none"} spf=${spf || "none"}`,
    dmarc, compauth, dkim, spf,
  };
}

/**
 * Verify one inbound email message's sender authentication.
 * `fetchHeader(messageId)` resolves to the Authentication-Results value(s) for
 * that Graph message id (injectable for tests; defaults are wired by the caller
 * so this module never imports the Graph client).
 *
 * Fail CLOSED: no message id, a fetch failure, or a non-pass verdict all return
 * verified:false. With EMAIL_AUTH_CHECK=false every message is treated as
 * verified (enforcement off), but the real verdict is still logged.
 * @returns {Promise<{verified:boolean, reason:string, enforced:boolean}>}
 */
export async function verifyEmailSender(msg, { fetchHeader } = {}) {
  const enforced = EMAIL_AUTH_ENFORCED;
  const id = msg?.graphMessageId;
  if (!id) {
    log.warn("email sender unverifiable (no graphMessageId)", { from: msg?.from, enforced });
    return { verified: !enforced, reason: "no graphMessageId", enforced };
  }
  if (typeof fetchHeader !== "function") {
    log.warn("email sender unverifiable (no header fetcher)", { from: msg?.from, enforced });
    return { verified: !enforced, reason: "no header fetcher", enforced };
  }
  let header;
  try {
    header = await fetchHeader(id);
  } catch (err) {
    log.warn("email auth header fetch failed", { from: msg?.from, reason: String(err?.message || err), enforced });
    return { verified: !enforced, reason: `header fetch failed: ${err?.message || err}`, enforced };
  }
  const v = authResultsVerdict(header);
  if (!v.verified) {
    log.warn("email sender FAILED authentication", { from: msg?.from, reason: v.reason, enforced });
  }
  return { verified: enforced ? v.verified : true, reason: v.reason, enforced };
}
