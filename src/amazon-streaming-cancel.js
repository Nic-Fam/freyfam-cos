// ===========================================================================
// Amazon CHANNEL streaming-subscription cancel playbook (ported from the legacy
// Frey Family Assistant, 2026-07-03). Turns off auto-renew on an Amazon-managed
// streaming channel (AMC+, Paramount+, MGM+, BritBox, ...) via Claude-in-Chrome
// driving the family's LOGGED-IN Chrome. One canonical page per Amazon login, so
// one playbook covers every channel.
//
// WHY NOT THE DAEMON: Amazon's cancellation UI is dynamic + bot-hostile, so this
// is LLM-driven (Claude-in-Chrome), not scripted Playwright. The cos daemon has no
// Claude-in-Chrome, so this runs when a Claude Code session drives it (like the
// order-history scrape), NOT autonomously. This module is the versioned, testable
// playbook + guards that session uses.
//
// HARD SAFETY (this cancels a paid service on the family's account):
//   - Prime is REFUSED at multiple layers. Never auto-cancel Prime.
//   - The Amazon account is VERIFIED as the family's (not a parallel/assistant
//     account) before anything is touched.
//   - The specific cancel is CONFIRMED with the family in chat first (human in the
//     loop) before the operator clicks anything.
//   - No refunds requested: keep the already-paid current period.
// ===========================================================================

export const SUBSCRIPTIONS_URL =
  process.env.AMAZON_SUBS_URL || "https://www.amazon.com/gp/your-account/subscriptions";

// Claude-in-Chrome tools the operator session needs to run the playbook.
export const CANCEL_ALLOWED_TOOLS = [
  "mcp__Claude_in_Chrome__list_connected_browsers",
  "mcp__Claude_in_Chrome__select_browser",
  "mcp__Claude_in_Chrome__navigate",
  "mcp__Claude_in_Chrome__get_page_text",
  "mcp__Claude_in_Chrome__read_page",
  "mcp__Claude_in_Chrome__find",
  "mcp__Claude_in_Chrome__computer",
  "mcp__Claude_in_Chrome__tabs_context_mcp",
];

// Account/profile hints — channel subs live on the FAMILY Amazon account. A
// parallel "assistant" account must never be touched.
export function accountHints() {
  return {
    profile: process.env.AMAZON_PROFILE_HINT || "Nic",
    expected: (process.env.AMAZON_ACCOUNT_NAME_HINT || "Nic").toLowerCase(),
    assistant: (process.env.AMAZON_ASSISTANT_NAME_HINT || "Assistant").toLowerCase(),
  };
}

// Prime guard. The whole point is channel add-ons; Prime membership is never a
// valid target. Checked before the run AND against whatever the operator reports.
export function isPrimeChannel(name) {
  const n = String(name || "").toLowerCase();
  return /\bprime\b/.test(n) || n.includes("amazon prime");
}

/**
 * Build the operator playbook for canceling ONE channel's auto-renew. Pure.
 * @param {{channel:string, amount?:string, renewalDate?:string}} sub
 */
export function buildCancelPlaybook({ channel, amount = null, renewalDate = null } = {}) {
  const { profile, expected, assistant } = accountHints();
  return [
    `Turn off auto-renew on ONE Amazon-managed streaming CHANNEL subscription, via Claude-in-Chrome on the family's logged-in Chrome. Read-and-cancel only; never buy, never refund.`,
    ``,
    `TARGET CHANNEL: ${channel}`,
    amount ? `Renewal amount on the receipt: ${amount}` : null,
    renewalDate ? `Renewal date on the receipt: ${renewalDate}` : null,
    ``,
    `ACCOUNT GUARD: channel subs live on the family's Amazon account. If a parallel/assistant Amazon account is also connected, cancelling there is wrong. Verify before touching anything.`,
    ``,
    `STEPS:`,
    `1. list_connected_browsers. If more than one is connected, select the one whose name contains "${profile}" (case-insensitive). If none matches, STOP: {"ok":false,"reason":"wrong_amazon_account","notes":"couldn't select the family's Chrome"}.`,
    `2. Open ${SUBSCRIPTIONS_URL}.`,
    `3. If a sign-in prompt appears, STOP (do NOT sign in): {"ok":false,"reason":"amazon_not_signed_in"}.`,
    `4. ACCOUNT VERIFICATION (mandatory). Read the header greeting ("Hello, <name>").`,
    `   - contains "${assistant}" -> STOP {"ok":false,"reason":"wrong_amazon_account","notes":"assistant account"}.`,
    `   - does NOT contain "${expected}" -> STOP {"ok":false,"reason":"unknown_amazon_account","notes":"<name you saw>"}.`,
    `   - matches "${expected}" -> proceed.`,
    `5. Find the subscription matching "${channel}" (closest case-insensitive match). If absent: {"ok":false,"reason":"channel_not_found"}.`,
    `6. CRITICAL: if the row mentions "Prime"/"Amazon Prime", REFUSE: {"ok":false,"reason":"prime_refused"}.`,
    `7. Open its management page and turn OFF auto-renew (wording varies: "End Subscription" / "Turn off auto-renew" / "Do not renew"). Follow confirmations. Do NOT request a refund.`,
    `8. Capture the confirmation page (screenshot, or page text if no screenshot tool).`,
    `9. Output EXACTLY one JSON line, nothing else:`,
    `   success: {"ok":true,"channel":"<name Amazon showed>","accountVerifiedAs":"<greeting text>","notes":"<one sentence>"}`,
    `   failure: {"ok":false,"reason":"amazon_not_signed_in|wrong_amazon_account|unknown_amazon_account|channel_not_found|prime_refused|confirmation_failed|other","notes":"<detail>"}`,
    ``,
    `HARD RULES: never cancel Prime; never touch a non-target subscription; never request a refund; never sign in; if the layout/confirmation/2FA looks off, STOP with ok=false and a reason.`,
  ].filter((l) => l !== null).join("\n");
}

/**
 * Post-run guard on the operator's reported result: refuse Prime or a
 * wrong/unknown account even if it claims ok. Pure. @returns {{ok, reason?, channel?}}
 */
export function validateCancelResult(parsed) {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "no_result" };
  if (isPrimeChannel(parsed.channel)) return { ok: false, reason: "prime_refused" };
  const { expected, assistant } = accountHints();
  const verified = String(parsed.accountVerifiedAs || "").toLowerCase();
  if (parsed.ok && verified) {
    if (verified.includes(assistant)) return { ok: false, reason: "wrong_amazon_account" };
    if (!verified.includes(expected)) return { ok: false, reason: "unknown_amazon_account" };
  }
  if (!parsed.ok) return { ok: false, reason: parsed.reason || "other" };
  return { ok: true, channel: parsed.channel };
}
