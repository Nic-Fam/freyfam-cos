// ===========================================================================
// CVS pharmacy playbook (revived + extended from the legacy Frey Family Assistant).
// Two capabilities, both via Claude-in-Chrome on the family's logged-in Chrome:
//   1. OTC ordering (cvs.com) — vitamins, toothpaste, OTC meds — from the "CVS"
//      Alexa -> Microsoft To-Do list. Two-phase fill->submit like grocery.
//   2. Rx SYNC — align the regular prescriptions onto ONE monthly delivery by
//      DELAYING early refills, without letting any sit past its return-to-stock
//      deadline. Timing is computed deterministically by rx.js planRxSync(); this
//      playbook just applies it on cvs.com's manage-prescriptions page.
//
// Rx is HIGHER STAKES than OTC (health, insurance, pharmacist verification), so:
//   - CONTROLLED substances are never auto-adjusted — flag them for the family.
//   - Any med that would be returned to stock before the synced date (planRxSync
//     `conflicts`) is SURFACED, not touched.
//   - Nothing is submitted without the family's YES (confirm.js), same as OTC.
//   - Verify each prescription is still active/on-file before changing its timing.
// ===========================================================================

export const CVS_URLS = {
  otcCart: process.env.CVS_CART_URL || "https://www.cvs.com/cart",
  prescriptions: process.env.CVS_RX_URL || "https://www.cvs.com/account/prescriptions",
};

export const PHARMACY_ALLOWED_TOOLS = [
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

export function pharmacyHints() {
  return {
    profile: process.env.GROCERY_PROFILE_HINT || "Nic",
    account: (process.env.CVS_ACCOUNT_NAME_HINT || process.env.GROCERY_ACCOUNT_NAME_HINT || "Nic").toLowerCase(),
    address: process.env.HOME_DELIVERY_HINT || "the family's home address",
    spendCap: Number(process.env.CVS_OTC_SPEND_CAP || 120),
  };
}

const CONTROLLED = /\b(adderall|ritalin|vyvanse|concerta|oxycodone|oxycontin|hydrocodone|percocet|xanax|alprazolam|ativan|lorazepam|klonopin|clonazepam|valium|diazepam|fentanyl|morphine|codeine|tramadol|ambien|zolpidem|testosterone|ketamine|suboxone|buprenorphine)\b/i;
export function isControlled(medName) {
  return CONTROLLED.test(String(medName || ""));
}

/** CVS OTC order, two-phase fill->submit (parallel to grocery). Pure. */
export function buildCvsOtcPlaybook({ phase = "fill", items = [], delivery = true, spendCap } = {}) {
  const h = pharmacyHints();
  const cap = Number.isFinite(Number(spendCap)) ? Number(spendCap) : h.spendCap;
  const mode = delivery ? "delivery" : "pickup";
  const list = items.map((i, n) => `  ${n + 1}. ${i.quantity && i.quantity !== 1 ? `${i.quantity}x ` : ""}${i.item}${i.note ? ` (${i.note})` : ""}`).join("\n");

  if (phase === "submit") {
    return [
      `PLACE the CVS OTC order already in the cart and reviewed — the family approved it. Claude-in-Chrome, their logged-in Chrome.`,
      `1. list_connected_browsers; select the "${h.profile}" browser. If none, STOP {"ok":false,"reason":"wrong_browser"}.`,
      `2. Open ${CVS_URLS.otcCart}. If it asks to sign in, STOP {"ok":false,"reason":"not_signed_in"}.`,
      `3. Confirm the cart matches the reviewed order and total <= $${cap}; else STOP {"ok":false,"reason":"cart_changed"}.`,
      `4. Place the order. Do NOT apply/remove ExtraCare coupons, add memberships, or accept upsells. Capture order # + total.`,
      `5. Output one JSON line: {"ok":true,"store":"cvs","orderNumber":"<#>","total":<number>}  |  {"ok":false,"reason":"...","notes":"..."}`,
    ].join("\n");
  }
  return [
    `Build a CVS ${mode} OTC cart via Claude-in-Chrome on the family's logged-in Chrome, then STOP for review. DO NOT place it. OTC items ONLY — never touch prescriptions here.`,
    ``,
    `ITEMS (from the CVS shopping list):`,
    list || "  (none — STOP, nothing to order)",
    ``,
    `STEPS:`,
    `1. list_connected_browsers; select the "${h.profile}" browser. If none, STOP {"ok":false,"reason":"wrong_browser"}.`,
    `2. Open cvs.com. If it asks to sign in, STOP {"ok":false,"reason":"not_signed_in"} — never sign in.`,
    `3. Confirm the family's account ("${h.account}") and ${mode} to ${h.address}; else STOP {"ok":false,"reason":"wrong_account_or_address"}.`,
    `4. Add each item (closest match to the usual brand/size, set quantity). Leave ExtraCare coupons ALONE.`,
    `5. OUT-OF-STOCK: drop unavailable items and note them; do not substitute.`,
    `6. Go to the review page, READ the total, do NOT place.`,
    `7. Output one JSON line: {"ok":true,"store":"cvs","phase":"fill","added":[{"item":"<n>","qty":<n>}],"dropped":["<oos>"],"total":<number>}  |  {"ok":false,"reason":"...","notes":"..."}`,
    ``,
    `HARD RULES: OTC only (no Rx); never sign in; never place in this phase; no substitutions/memberships/upsells; flag a total > $${cap}; STOP on anything odd.`,
  ].filter((l) => l !== null).join("\n");
}

/**
 * Rx-SYNC playbook. `plan` is rx.js planRxSync() output: {deliverOn, hold:[{name,...}],
 * conflicts:[{name,...}]}. The operator aligns the `hold` meds' next fill/ship to
 * `deliverOn`; controlled meds and `conflicts` are surfaced, never auto-changed. Pure.
 */
export function buildRxSyncPlaybook({ plan = {} } = {}) {
  const h = pharmacyHints();
  const deliverOn = plan.deliverOn || "(the computed monthly date)";
  const hold = Array.isArray(plan.hold) ? plan.hold : [];
  const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : [];
  const controlledInHold = hold.filter((m) => isControlled(m.name)).map((m) => m.name);
  const adjustable = hold.filter((m) => !isControlled(m.name));

  return [
    `Align the family's REGULAR CVS prescriptions to ONE monthly delivery on ${deliverOn}, via Claude-in-Chrome on their logged-in Chrome. This changes refill/ship TIMING only — it does NOT start a new prescription and does NOT touch dosage. Review-and-STOP: do not confirm any change without the family's YES (they approve via chat).`,
    ``,
    `MEDS TO ALIGN (delay next fill/ship so they all land on ${deliverOn}):`,
    adjustable.length ? adjustable.map((m, n) => `  ${n + 1}. ${m.name}${m.readyDate ? ` (ready ${m.readyDate})` : ""}${m.returnByDate ? ` [return-to-stock ${m.returnByDate}]` : ""}`).join("\n") : "  (none)",
    ``,
    controlledInHold.length ? `DO NOT TOUCH (controlled — flag for the family to handle at the pharmacy): ${controlledInHold.join(", ")}` : `No controlled meds in scope.`,
    conflicts.length ? `DO NOT TOUCH (would be returned to stock before ${deliverOn} — surface for the family): ${conflicts.map((m) => m.name).join(", ")}` : `No return-to-stock conflicts.`,
    ``,
    `STEPS:`,
    `1. list_connected_browsers; select the "${h.profile}" browser. If none, STOP {"ok":false,"reason":"wrong_browser"}.`,
    `2. Open ${CVS_URLS.prescriptions}. If it asks to sign in / 2FA, STOP {"ok":false,"reason":"not_signed_in"} — never sign in.`,
    `3. Confirm the family's account ("${h.account}"). Else STOP {"ok":false,"reason":"wrong_account"}.`,
    `4. For EACH med in "MEDS TO ALIGN": verify it is ACTIVE/on-file with refills remaining. If it needs a doctor reauthorization or is inactive, note it and skip (do not force).`,
    `5. Set that med's next fill/delivery date to ${deliverOn} (or enroll it in monthly auto-refill timed to ${deliverOn}). Only adjust TIMING. Never adjust a controlled med or a conflict med listed above.`,
    `6. Go to the review/summary page showing the new dates. Do NOT confirm/submit the changes yet.`,
    `7. Output one JSON line: {"ok":true,"deliverOn":"${deliverOn}","aligned":[{"name":"<med>","newDate":"${deliverOn}"}],"skipped":[{"name":"<med>","why":"<reason>"}],"flagged":["<controlled/conflict/reauth>"]}  |  {"ok":false,"reason":"not_signed_in|wrong_account|wrong_browser|other","notes":"<detail>"}`,
    ``,
    `HARD RULES: timing only; never change dosage; never adjust a controlled med or a return-to-stock conflict; never sign in; never confirm without the family's YES; STOP on 2FA or anything ambiguous.`,
  ].filter((l) => l !== null).join("\n");
}

/** Guard the operator's Rx-sync result: strip any controlled med that slipped through. Pure. */
export function validateRxSyncResult(parsed) {
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "no_result" };
  if (!parsed.ok) return { ok: false, reason: parsed.reason || "other" };
  const aligned = (parsed.aligned || []).filter((a) => a && !isControlled(a.name));
  const rejectedControlled = (parsed.aligned || []).filter((a) => a && isControlled(a.name)).map((a) => a.name);
  return { ok: true, deliverOn: parsed.deliverOn || null, aligned, skipped: parsed.skipped || [], flagged: [...(parsed.flagged || []), ...rejectedControlled] };
}

/** Guard the OTC result (over-cap refusal), parallel to grocery. Pure. */
export function validateOtcResult(parsed, { spendCap } = {}) {
  const h = pharmacyHints();
  const cap = Number.isFinite(Number(spendCap)) ? Number(spendCap) : h.spendCap;
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "no_result" };
  if (!parsed.ok) return { ok: false, reason: parsed.reason || "other" };
  if (Number.isFinite(Number(parsed.total)) && Number(parsed.total) > cap) return { ok: false, reason: "over_cap", total: Number(parsed.total), cap };
  return { ok: true, total: parsed.total ?? null, orderNumber: parsed.orderNumber ?? null, dropped: parsed.dropped || [] };
}
