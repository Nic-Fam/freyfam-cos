// ===========================================================================
// Grocery ORDER playbook (revived from the legacy Frey Family Assistant, 2026-07).
// Ralphs (ralphs.com) and Costco (Instacart, Costco storefront) via Claude-in-Chrome
// driving the family's LOGGED-IN Chrome on a local Mac. Cart source is the Alexa ->
// Microsoft To-Do list per store (read cheaply via graph; see grocery.js).
//
// WHY NOT THE DAEMON: grocery checkout UIs are dynamic + bot-hostile, so this is
// LLM-driven (Claude-in-Chrome), not scripted Playwright. The cos daemon has no
// Claude-in-Chrome — it PROPOSES the order (reads the list, builds the cart summary,
// stages it through confirm.js) and this module is the versioned, testable playbook
// a Claude Code session runs to fill + submit the cart.
//
// TWO PHASES so the money-spend stays behind the gate (hard constraint #2/#3):
//   "fill"   -> add items, clip coupons, pick the slot, DROP out-of-stock, stop at
//               the review page, report the cart (items + total + slot). NEVER places.
//   "submit" -> only after the family's YES: place the already-reviewed order.
//
// HARD SAFETY: verify the family's account + home delivery address; a spend cap
// refuses an order whose total blew past expectations; out-of-stock items are
// DROPPED (never auto-substituted); pickup/slot must be the family's, not a default.
// ===========================================================================

export const STORE_URLS = {
  ralphs: process.env.RALPHS_URL || "https://www.ralphs.com/cart",
  costco: process.env.INSTACART_COSTCO_URL || "https://www.instacart.com/store/costco/storefront",
};

// Claude-in-Chrome tools the operator session needs.
export const GROCERY_ALLOWED_TOOLS = [
  "mcp__Claude_in_Chrome__list_connected_browsers",
  "mcp__Claude_in_Chrome__select_browser",
  "mcp__Claude_in_Chrome__navigate",
  "mcp__Claude_in_Chrome__get_page_text",
  "mcp__Claude_in_Chrome__read_page",
  "mcp__Claude_in_Chrome__find",
  "mcp__Claude_in_Chrome__form_input",
  "mcp__Claude_in_Chrome__computer",
  "mcp__Claude_in_Chrome__tabs_context_mcp",
];

export function groceryHints() {
  return {
    profile: process.env.GROCERY_PROFILE_HINT || "Nic",
    account: (process.env.GROCERY_ACCOUNT_NAME_HINT || "Nic").toLowerCase(),
    address: process.env.HOME_DELIVERY_HINT || "the family's home address",
    spendCap: Number(process.env.GROCERY_SPEND_CAP || 350), // refuse an order above this
  };
}

const STORE_LABEL = { ralphs: "Ralphs (ralphs.com)", costco: "Costco (Instacart Costco storefront)" };

/**
 * Build the operator playbook for a grocery order. Pure + testable.
 * @param {{store:"ralphs"|"costco", phase:"fill"|"submit", items:Array<{item,quantity,note}>,
 *          delivery?:boolean, applyFuelCoupon?:boolean, spendCap?:number}} o
 */
export function buildGroceryPlaybook({ store = "ralphs", phase = "fill", items = [], delivery = true, applyFuelCoupon = false, spendCap } = {}) {
  const h = groceryHints();
  const cap = Number.isFinite(Number(spendCap)) ? Number(spendCap) : h.spendCap;
  const url = STORE_URLS[store];
  const label = STORE_LABEL[store] || store;
  const mode = delivery ? "delivery" : "pickup";
  const list = items.map((i, n) => `  ${n + 1}. ${i.quantity && i.quantity !== 1 ? `${i.quantity}x ` : ""}${i.item}${i.note ? ` (${i.note})` : ""}`).join("\n");

  if (phase === "submit") {
    return [
      `PLACE the ${label} order that is ALREADY in the cart and reviewed — the family approved it. Via Claude-in-Chrome on their logged-in Chrome.`,
      `1. list_connected_browsers; select the one whose name contains "${h.profile}" (case-insensitive). If none, STOP {"ok":false,"reason":"wrong_browser"}.`,
      `2. Open ${url}. If a sign-in prompt appears, STOP {"ok":false,"reason":"not_signed_in"} — do NOT sign in.`,
      `3. Confirm the cart still matches the reviewed order and the total is <= $${cap}. If it changed materially or exceeds the cap, STOP {"ok":false,"reason":"cart_changed","notes":"<what changed>"}.`,
      `4. Place the order (button wording varies: "Place order" / "Check out" / "Submit order"). Complete any final confirmation. Do NOT change the tip, add memberships, or accept upsells.`,
      `5. Capture the confirmation (order #, total, ${mode} window).`,
      `6. Output EXACTLY one JSON line: success {"ok":true,"store":"${store}","orderNumber":"<#>","total":<number>,"window":"<slot>"}  |  failure {"ok":false,"reason":"not_signed_in|cart_changed|over_cap|checkout_failed|other","notes":"<detail>"}`,
    ].join("\n");
  }

  // phase "fill"
  return [
    `Build a ${mode} cart at ${label} via Claude-in-Chrome on the family's logged-in Chrome, then STOP for their review. DO NOT place the order in this phase.`,
    ``,
    `ITEMS (from the ${store === "ralphs" ? "Ralphs" : "Costco"} shopping list):`,
    list || "  (none — STOP, nothing to order)",
    ``,
    `STEPS:`,
    `1. list_connected_browsers; select the one whose name contains "${h.profile}". If none, STOP {"ok":false,"reason":"wrong_browser"}.`,
    `2. Open ${url}. If it asks you to sign in, STOP {"ok":false,"reason":"not_signed_in"} — never sign in.`,
    `3. ACCOUNT/ADDRESS GUARD: confirm you are in the family's account (greeting/name contains "${h.account}") and the ${mode} target is ${h.address}. If not, STOP {"ok":false,"reason":"wrong_account_or_address"}.`,
    store === "ralphs" && applyFuelCoupon
      ? `4. Clip the "4X fuel points" digital coupon (Savings/Coupons section) so it applies to this order — this order runs on a Friday specifically for it.`
      : `4. (No coupon step.)`,
    `5. Add each item above (search, pick the closest match to the family's usual brand/size, set the quantity).`,
    `6. OUT-OF-STOCK POLICY: if an item is unavailable, DROP it and note it — do NOT auto-substitute and do NOT block the rest.`,
    `7. Set the ${mode} to the soonest ${store === "ralphs" ? "FRIDAY EVENING" : "available"} slot at ${h.address}.`,
    `8. Go to the review/checkout page and READ the order total. Do NOT place it.`,
    `9. Output EXACTLY one JSON line: {"ok":true,"store":"${store}","phase":"fill","added":[{"item":"<name>","qty":<n>}],"dropped":["<oos item>"],"total":<number>,"window":"<slot>"}  or  {"ok":false,"reason":"not_signed_in|wrong_account_or_address|wrong_browser|other","notes":"<detail>"}`,
    ``,
    `HARD RULES: never sign in; never place the order in this phase; never auto-substitute a dropped item; never add memberships/warranties/upsells; if the total looks wildly off (> $${cap}) flag it in notes; if anything (2FA, layout, address) looks off, STOP with ok=false.`,
  ].filter((l) => l !== null).join("\n");
}

/**
 * Post-run guard on the operator's reported result. Pure. Refuses an over-cap or
 * unverified order even if the operator claims ok. @returns {{ok, reason?, ...}}
 */
export function validateGroceryResult(parsed, { spendCap } = {}) {
  const h = groceryHints();
  const cap = Number.isFinite(Number(spendCap)) ? Number(spendCap) : h.spendCap;
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "no_result" };
  if (!parsed.ok) return { ok: false, reason: parsed.reason || "other" };
  if (Number.isFinite(Number(parsed.total)) && Number(parsed.total) > cap) {
    return { ok: false, reason: "over_cap", total: Number(parsed.total), cap };
  }
  return { ok: true, store: parsed.store, total: parsed.total ?? null, orderNumber: parsed.orderNumber ?? null, dropped: parsed.dropped || [] };
}
