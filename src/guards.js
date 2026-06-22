import { WORK_DOMAINS, GRAPH, FAMILY_ADDRESSES } from "./config.js";

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
