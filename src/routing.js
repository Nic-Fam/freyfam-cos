// Lightweight routing hints for inbound messages. The chief (Lloyd) already decides
// where to route via triage + persona; this just hands him cheap, deterministic
// SUGGESTIONS from the subject/body so common kinds land in the right place: receipts
// -> finance (Patrick), shipping updates -> package tracking, calendar invites ->
// scheduling. Conservative + advisory (never a hard route) so a stray keyword can't
// misroute — the model still makes the call. Pure + testable.

const SIGNALS = [
  { hint: "looks like a receipt/billing — consider finance (Patrick)", re: /\b(receipt|invoice|order confirmation|your order|payment received|statement|past due|amount due|subscription (?:renew|charge)|auto-?renew)\b/i },
  { hint: "looks like a shipping update — consider tracking the package", re: /\b(shipped|tracking number|out for delivery|on its way|will arrive|arriving|delivered|track your (?:package|order))\b/i },
  { hint: "looks like a calendar invite — consider scheduling it", re: /\b(meeting request|calendar invite|you'?re invited|invitation to|please rsvp|\binvite\b)\b/i },
];

/**
 * Return advisory routing hints for a message. Deduped, conservative. Pure.
 * @param {string} subject
 * @param {string} body
 * @returns {string[]}
 */
export function routingHints(subject = "", body = "") {
  const text = `${subject || ""}\n${body || ""}`;
  const hints = [];
  for (const s of SIGNALS) {
    if (s.re.test(text)) hints.push(s.hint);
  }
  return hints;
}
