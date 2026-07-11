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

test("captureReceipt stores, dedups by sender+subject+day, and lists back", async () => {
  const row = await r.captureReceipt({ from: "no-reply@doordash.com", subject: "Your order", body: "Total $23.40", at: "2026-07-11T18:00:00Z" });
  assert.ok(row && row.vendor);
  const dup = await r.captureReceipt({ from: "no-reply@doordash.com", subject: "Your order", body: "Total $23.40", at: "2026-07-11T19:00:00Z" });
  assert.equal(dup, null, "same sender+subject+day is not stored twice");
  const list = await r.listReceipts({ sinceDays: 3650 }, new Date("2026-07-12T00:00:00Z"));
  assert.equal(list.length, 1);
  assert.equal(list[0].total, 23.4);
});
