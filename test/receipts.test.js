import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-receipts-test.json");
process.env.RECEIPTS_PATH = TMP;
const r = await import("../src/receipts.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("isReceipt: needs a receipt phrase AND a currency amount", () => {
  assert.equal(r.isReceipt({ subject: "Your order confirmation", body: "Order total: $42.10" }), true);
  assert.equal(r.isReceipt({ subject: "Order #123 receipt", body: "Total $8.99" }), true);
  assert.equal(r.isReceipt({ subject: "hi there", body: "let's grab lunch" }), false); // no phrase/amount
  assert.equal(r.isReceipt({ subject: "receipt attached", body: "see attachment" }), false); // phrase but no amount
});

test("parseTotal: prefers the 'Total' line over subtotal, else the largest amount", () => {
  assert.equal(r.parseTotal("Subtotal $30.00\nTax $2.50\nTotal $32.50"), 32.5);
  assert.equal(r.parseTotal("Item A $5.00\nItem B $19.99"), 19.99); // no total line -> max
});

test("parseReceipt: vendor + grocery/prepared classification", () => {
  const groc = r.parseReceipt({ from: "receipts@instacart.com", subject: "Your Instacart order", body: "Total $88.20" });
  assert.equal(groc.kind, "grocery");
  assert.match(groc.vendor, /instacart/i);
  const food = r.parseReceipt({ from: "no-reply@doordash.com", subject: "Order receipt", body: "Total $23.40" });
  assert.equal(food.kind, "prepared");
  assert.equal(food.total, 23.4);
});

test("parseReceipt: forwards resolve vendor from subject/body (not the gmail forwarder); Amazon supported", () => {
  const amz = r.parseReceipt({ from: "nfrey2@gmail.com", subject: "Fwd: Order Confirmed, Nicholas", body: "Your order from Amazon.com. Order total $208.18" });
  assert.equal(amz.vendor, "Amazon");
  assert.equal(amz.kind, "other"); // general Amazon is spend, not pantry
  assert.equal(amz.total, 208.18);
  const inst = r.parseReceipt({ from: "nfrey2@gmail.com", subject: "Fwd: Your Instacart order receipt", body: "Total $270.74" });
  assert.equal(inst.vendor, "Instacart");
  assert.equal(inst.kind, "grocery");
  const unknown = r.parseReceipt({ from: "nfrey2@gmail.com", subject: "Fwd: Nic, we got your order!", body: "Total $127.29" });
  assert.notEqual(unknown.vendor.toLowerCase(), "gmail"); // never the forwarding address
});

test("reconcileReceipts matches a receipt to its card charge (incl. tip)", () => {
  const receipts = [{ vendor: "doordash", total: 40.0, date: "2026-07-11" }];
  const txns = [{ merchant: "DOORDASH*ORDER 55", amount: 46.0, date: "2026-07-11" }]; // +$6 tip
  const { matched, pending, discrepancies } = r.reconcileReceipts(receipts, txns);
  assert.equal(matched.length, 1);
  assert.equal(pending.length, 0);
  assert.equal(discrepancies.length, 0);
  assert.equal(matched[0].tip, 6);
});

test("reconcileReceipts: no charge -> pending; wildly-off amount -> discrepancy", () => {
  assert.equal(r.reconcileReceipts([{ vendor: "chipotle", total: 22, date: "2026-07-11" }], []).pending.length, 1);
  const d = r.reconcileReceipts(
    [{ vendor: "chipotle", total: 22, date: "2026-07-11" }],
    [{ merchant: "CHIPOTLE 123", amount: 88.0, date: "2026-07-11" }] // $88 vs $22 -> out of tip range
  );
  assert.equal(d.discrepancies.length, 1);
  assert.equal(d.matched.length, 0);
});

test("estimateServings scales with the order total", () => {
  assert.equal(r.estimateServings({ total: 80 }), 5);
  assert.equal(r.estimateServings({ total: 0 }), 0);
});

test("leftoverEstimate: big order for 3 -> leftovers; guest event suppresses; grocery skipped", () => {
  const receipt = { kind: "prepared", total: 96, date: "2026-07-11" }; // ~6 servings
  const none = r.leftoverEstimate({ receipt, events: [], familySize: 3 });
  assert.equal(none.likely, true);
  assert.equal(none.leftovers, 3);
  const guests = r.leftoverEstimate({ receipt, events: [{ subject: "Dinner with the Kims", start: "2026-07-11T18:00:00" }], familySize: 3 });
  assert.equal(guests.likely, false);
  assert.equal(guests.guests, true);
  assert.equal(r.leftoverEstimate({ receipt: { kind: "grocery", total: 96, date: "2026-07-11" } }).likely, false);
});

test("captureReceipt stores, dedups by sender+subject+day, and lists back", async () => {
  const row = await r.captureReceipt({ from: "no-reply@doordash.com", subject: "Your order", body: "Total $23.40", at: "2026-07-11T18:00:00Z" });
  assert.ok(row && row.vendor);
  const dup = await r.captureReceipt({ from: "no-reply@doordash.com", subject: "Your order", body: "Total $23.40", at: "2026-07-11T19:00:00Z" });
  assert.equal(dup, null, "same sender+subject+day is not stored twice");
  const list = await r.listReceipts({ sinceDays: 3650 }, new Date("2026-07-12T00:00:00Z"));
  assert.equal(list.length, 1);
  assert.equal(list[0].total, 23.4);
});
