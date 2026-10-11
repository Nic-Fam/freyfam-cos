import { WORK_DOMAINS, GRAPH, FAMILY_ADDRESSES, INBOUND_EMAIL_ALLOW, IMESSAGE, SLACK } from "./config.js";

// ===========================================================================
// Outbound policy (updated 2026-06-20). Work domains (flyerdefense.com,
// disney.com) are NO LONGER hard-blocked. Instead:
//   - the family's OWN work addresses may appear as calendar invitees freely;
//   - sending EMAIL to a work domain is allowed but high-stakes, so it routes
//     through the confirmation gate (confirm.js) like any outbound.
// So this module no longer throws; it just classifies recipients so callers can
// flag work-domain sends in the approval prompt. Protection now rests on the
// confirmation gate, not an absolute wall.
// ===========================================================================

function domainsOf(addressOrList) {
  const list = Array.isArray(addressOrList) ? addressOrList : [addressOrList];
  return list
    .map((a) => String(a).toLowerCase())
    .map((a) => (a.includes("@") ? a.split("@").pop() : a))
    .map((d) => d.trim());
}

/** True if any recipient is on a configured work domain (so callers can flag it). */
export function isWorkDomain(recipients) {
  return domainsOf(recipients).some((d) => WORK_DOMAINS.includes(d));
}

// ===========================================================================
// Auto-reply suppression. The email front door enqueues everything that lands
// in the assistant mailbox, but we must NOT auto-reply to machine senders:
//   - bounces / system mailers (replying to a bounce makes another bounce: a
//     self-feeding loop, observed 2026-06-20 with MAILER-DAEMON@amazon.com);
//   - no-reply / notification / marketing addresses (RFC 3834 spirit);
//   - our OWN mailbox (self-loop).
// SMS/Slack senders (phone numbers, Slack user ids) never match these, so this
// only gates email. The family writes from personal human addresses, which
// don't match, so false positives are unlikely.
// ===========================================================================

// Self addresses we must never reply to (mailbox + the assistant@ alias).
const SELF_ADDRESSES = [String(GRAPH.mailbox || "").toLowerCase(), "assistant@freyfam.com"].filter(Boolean);

// Local-part tokens typical of unattended/bulk senders.
const AUTOMATED_LOCALPARTS = [
  "mailer-daemon", "postmaster", "no-reply", "noreply", "no_reply", "donotreply",
  "do-not-reply", "bounce", "bounces", "notification", "notifications", "notify",
  "no.reply", "auto-confirm", "automated", "mailer", "order-update", "order-updates",
  "shipment-tracking", "tracking", "marketing", "newsletter", "news", "updates", "alerts",
];

// Subdomains that signal bulk/transactional mail streams (e.g. eml., marketing.email.).
const AUTOMATED_DOMAIN_TOKENS = ["marketing.", "email.", "eml.", "mailer.", "bounce.", "reply.", "mktg."];

/** True if `from` is our own mailbox (defends against a self-reply loop). */
export function isSelfAddress(from) {
  return SELF_ADDRESSES.includes(String(from || "").toLowerCase().trim());
}

/** True if `from` is one of the family's own addresses (household/personal/work).
 *  Used so the security watch never treats the family's OWN mail as a threat. */
export function isFamilyAddress(from) {
  return FAMILY_ADDRESSES.includes(String(from || "").toLowerCase().trim());
}

/**
 * True when EVERY recipient is one of the family's OWN NON-WORK addresses (and
 * there is at least one). Emailing the family's own inboxes is not "acting on the
 * family's behalf to an outside party", so send_email skips the confirmation gate
 * for these (policy 2026-07: "I don't need to approve an email to myself"). A
 * work-domain recipient (flyerdefense/disney — constraint #1) or ANY outside
 * address fails the test, so those still route through confirmation. Accepts a
 * string, a comma/semicolon list, or an array; splits each entry. Pure.
 */
export function isFamilySelfEmail(recipients) {
  const list = (Array.isArray(recipients) ? recipients : [recipients])
    .flatMap((v) => String(v || "").split(/[,;]/))
    .map((a) => a.toLowerCase().trim())
    .filter(Boolean);
  if (!list.length) return false;
  return list.every((a) => isFamilyAddress(a) && !isWorkDomain(a));
}

/**
 * True if `from` looks like an unattended/bulk/bounce sender we should not
 * auto-reply to. Matches on the local-part tokens and bulk subdomains above.
 */
export function isAutomatedSender(from) {
  const addr = String(from || "").toLowerCase().trim();
  if (!addr.includes("@")) return false; // not an email address (SMS/Slack) -> not automated
  const [local, domain = ""] = addr.split("@");
  if (AUTOMATED_LOCALPARTS.some((t) => local === t || local.includes(t))) return true;
  if (AUTOMATED_DOMAIN_TOKENS.some((t) => domain.includes(t))) return true;
  return false;
}

/**
 * Gate for the inbound auto-reply. False => skip the agent run AND the reply
 * (saves tokens and prevents loops). Only meaningful for email; SMS/Slack pass.
 */
export function shouldAutoReply(from) {
  return !isSelfAddress(from) && !isAutomatedSender(from);
}

// ===========================================================================
// Inbound authorization (hard constraint #1 + #2 protection). shouldAutoReply
// only screens out MACHINE senders; a human STRANGER who emails the public
// mailbox (cos@freyfam.com) still passed it and got a full agent run + reply —
// unauthenticated data exfiltration, and a lever to stage/approve outbound
// actions. This gate is the positive allowlist: only these senders may drive the
// chief or resolve an approval. Silent-capture paths (OTP relay, shipment/txn
// filing) run BEFORE this gate, so unattended service mail is still ingested; it
// just never triggers a model run, a reply, or an approval.
//
// Policy per channel (FAIL CLOSED, policy 2026-10-11):
//   - email       : family address OR INBOUND_EMAIL_ALLOW, AND the message's
//                   Authentication-Results must pass (src/email-auth.js, checked
//                   by the orchestrator — From alone is forgeable).
//   - imessage/sms: IMESSAGE_ALLOW must be set and contain the handle. An empty
//                   allowlist used to mean "allow all"; it now means nobody, because
//                   an Apple ID handle is guessable and any sender could otherwise
//                   type "YES <code>" and approve a staged action.
//   - slack       : SLACK_ALLOW must be set and contain the user id. Same reason:
//                   a workspace holds guests/contractors, and approval buttons are
//                   visible to every member of #command.
//   - voice       : trusted (localhost + token gated in voice-server.js).
//   - anything else: NOT trusted. Internal callers use the channels above.
// Operators see a boot-time warning (daemon.js) when a channel is enabled with
// an empty allowlist, so a lockout is loud, not silent.
// ===========================================================================
export function isAuthorizedSender(msg) {
  const channel = msg?.channel;
  const from = String(msg?.from || "").toLowerCase().trim();
  if (!from) return false;
  switch (channel) {
    case "email":
      return isFamilyAddress(from) || INBOUND_EMAIL_ALLOW.includes(from);
    case "imessage":
    case "sms":
      return IMESSAGE.allow.length > 0 && IMESSAGE.allow.includes(from);
    case "slack":
      // Slack user ids are case-sensitive, so compare the raw value too.
      return SLACK.allow.length > 0 && SLACK.allow.includes(String(msg?.from || "").trim());
    case "voice":
      return true;
    default:
      return false; // unknown channels are never trusted
  }
}

/**
 * Channels that are enabled but have no allowlist, so every sender on them is
 * now refused (fail closed). daemon.js logs these at boot. Pure; takes the
 * config objects so tests can pass their own.
 * @returns {string[]} e.g. ["imessage (set IMESSAGE_ALLOW)", "slack (set SLACK_ALLOW)"]
 */
export function openChannelWarnings({ imessage = IMESSAGE, slack = SLACK } = {}) {
  const out = [];
  if (imessage?.enabled && !(imessage.allow || []).length) out.push("imessage (set IMESSAGE_ALLOW to the family's handles; every iMessage is refused until then)");
  if (slack?.enabled && !(slack.allow || []).length) out.push("slack (set SLACK_ALLOW to the family's Slack user ids; every Slack message and approval tap is refused until then)");
  return out;
}
