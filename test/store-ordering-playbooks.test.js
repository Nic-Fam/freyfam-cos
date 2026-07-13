import { test } from "node:test";
import assert from "node:assert";
import { buildGroceryPlaybook, validateGroceryResult, STORE_URLS } from "../src/grocery-order-playbook.js";
import { buildCvsOtcPlaybook, buildRxSyncPlaybook, validateRxSyncResult, validateOtcResult, isControlled } from "../src/pharmacy-order-playbook.js";

const items = [{ item: "Bananas", quantity: 2 }, { item: "Oat milk", note: "unsweetened" }];

test("grocery fill playbook: items, Friday fuel coupon, OOS-drop, never places", () => {
  const p = buildGroceryPlaybook({ store: "ralphs", phase: "fill", items, applyFuelCoupon: true });
  assert.match(p, /Bananas/);
  assert.match(p, /4X fuel points/i);
  assert.match(p, /DROP it/); // out-of-stock policy
  assert.match(p, /DO NOT place/i);
  assert.match(p, /never auto-substitute/i);
});

test("grocery submit playbook places the reviewed order and honors the cap", () => {
  const p = buildGroceryPlaybook({ store: "ralphs", phase: "submit", items, spendCap: 200 });
  assert.match(p, /PLACE the/);
  assert.match(p, /\$200/);
});

test("costco routes through the Instacart Costco storefront", () => {
  const p = buildGroceryPlaybook({ store: "costco", phase: "fill", items });
  assert.match(p, /Instacart/i);
  assert.ok(STORE_URLS.costco.includes("instacart"));
});

test("validateGroceryResult: under cap ok, over cap refused, failure passthrough", () => {
  assert.equal(validateGroceryResult({ ok: true, store: "ralphs", total: 140 }, { spendCap: 350 }).ok, true);
  const over = validateGroceryResult({ ok: true, store: "ralphs", total: 900 }, { spendCap: 350 });
  assert.equal(over.ok, false);
  assert.equal(over.reason, "over_cap");
  assert.equal(validateGroceryResult({ ok: false, reason: "not_signed_in" }).reason, "not_signed_in");
});

test("isControlled flags scheduled meds, not OTC", () => {
  assert.equal(isControlled("Adderall XR 20mg"), true);
  assert.equal(isControlled("Lisinopril 10mg"), false);
});

test("CVS OTC fill playbook: OTC only, leaves ExtraCare alone", () => {
  const p = buildCvsOtcPlaybook({ phase: "fill", items: [{ item: "Vitamin D" }] });
  assert.match(p, /OTC only/i);
  assert.match(p, /ExtraCare coupons ALONE/i);
  assert.match(p, /DO NOT place/i);
});

test("Rx-sync playbook: controlled meds + return-to-stock conflicts are surfaced, not touched", () => {
  const plan = {
    deliverOn: "2026-08-01",
    hold: [{ name: "Lisinopril", readyDate: "2026-07-20" }, { name: "Adderall XR", readyDate: "2026-07-18" }],
    conflicts: [{ name: "Metformin", returnByDate: "2026-07-25" }],
  };
  const p = buildRxSyncPlaybook({ plan });
  assert.match(p, /2026-08-01/);
  assert.match(p, /Lisinopril/); // adjustable
  assert.match(p, /DO NOT TOUCH.*Adderall/s); // controlled -> flagged
  assert.match(p, /DO NOT TOUCH.*Metformin/s); // conflict -> flagged
  assert.match(p, /timing only/i);
});

test("validateRxSyncResult strips a controlled med the operator wrongly aligned", () => {
  const r = validateRxSyncResult({ ok: true, deliverOn: "2026-08-01", aligned: [{ name: "Lisinopril" }, { name: "Xanax" }], flagged: [] });
  assert.deepEqual(r.aligned.map((a) => a.name), ["Lisinopril"]);
  assert.ok(r.flagged.includes("Xanax"));
});

test("validateOtcResult refuses over-cap", () => {
  assert.equal(validateOtcResult({ ok: true, total: 999 }, { spendCap: 120 }).reason, "over_cap");
  assert.equal(validateOtcResult({ ok: true, total: 40 }, { spendCap: 120 }).ok, true);
});
