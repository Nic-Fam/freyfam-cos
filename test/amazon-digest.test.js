import { test } from "node:test";
import assert from "node:assert";
import { summarizeOrders, composeAmazonDigest, shouldRunAmazonDigest, runAmazonDigest } from "../src/amazon-digest.js";

const NOW = new Date("2026-06-30T19:30:00-07:00"); // a Tuesday evening PT

const ORDERS = [
  { orderId: "1", placedDate: "June 28, 2026", total: "$42.10", status: "delivered", deliveryLine: "Delivered Jun 29", items: [{ title: "Organic Oats", consumable: true }] },
  { orderId: "2", placedDate: "June 27, 2026", total: "$18.00", status: "arriving", deliveryLine: "Arriving tomorrow", items: [{ title: "USB-C Cable", consumable: false }] },
  { orderId: "3", placedDate: "May 1, 2026", total: "$99.99", status: "delivered", items: [{ title: "Blender", consumable: false }] }, // OUTSIDE 7d window
  { orderId: "4", placedDate: null, total: "$7.50", status: "shipped", items: [{ title: "Peet's Coffee", consumable: true }] }, // undated -> kept
];

test("summarizeOrders windows by placedDate and sums spend", () => {
  const s = summarizeOrders(ORDERS, { now: NOW, sinceDays: 7 });
  assert.equal(s.count, 3);                 // order #3 (May 1) excluded; undated #4 kept
  assert.equal(s.total, 67.6);              // 42.10 + 18.00 + 7.50
  assert.equal(s.byStatus.delivered, 1);
  assert.equal(s.byStatus.arriving, 1);
  assert.equal(s.byStatus.shipped, 1);
  assert.equal(s.arriving.length, 2);       // arriving + shipped
  assert.deepEqual(s.consumables, ["Organic Oats", "Peet's Coffee"]);
});

test("composeAmazonDigest renders spend, status, still-coming, and consumables", () => {
  const { subject, text } = composeAmazonDigest(summarizeOrders(ORDERS, { now: NOW, sinceDays: 7 }));
  assert.match(subject, /\$67\.60/);
  assert.match(text, /3 orders, \$67\.60 total/);
  assert.match(text, /Still coming \(2\)/);
  assert.match(text, /Consumables\/pantry \(for Carmine\): .*Oats/);
});

test("shouldRunAmazonDigest fires only on the configured weekday+window, once/day", () => {
  const cfg = { weekday: 0, hour: 19, windowHours: 3, tz: "America/Los_Angeles" }; // Sunday 7-10pm PT
  const sundayEve = new Date("2026-06-28T19:15:00-07:00"); // Sunday
  assert.equal(shouldRunAmazonDigest(sundayEve, null, cfg).run, true);
  // already ran today -> no
  const { date } = shouldRunAmazonDigest(sundayEve, null, cfg);
  assert.equal(shouldRunAmazonDigest(sundayEve, date, cfg).run, false);
  // wrong day
  assert.equal(shouldRunAmazonDigest(new Date("2026-06-30T19:15:00-07:00"), null, cfg).run, false);
  // right day, before window
  assert.equal(shouldRunAmazonDigest(new Date("2026-06-28T10:00:00-07:00"), null, cfg).run, false);
});

test("runAmazonDigest stays silent when not signed in", async () => {
  let notified = 0;
  const r = await runAmazonDigest({
    fetch: async () => ({ signedIn: false, orders: [], note: "sign in" }),
    notify: async () => { notified++; },
    now: NOW,
    cfg: { pages: 2, sinceDays: 7 },
  });
  assert.deepEqual(r, { sent: false, signedIn: false });
  assert.equal(notified, 0);
});

test("runAmazonDigest stays silent when no orders in the window", async () => {
  let notified = 0;
  const r = await runAmazonDigest({
    fetch: async () => ({ signedIn: true, orders: [ORDERS[2]] }), // only the out-of-window one
    notify: async () => { notified++; },
    now: NOW,
    cfg: { pages: 2, sinceDays: 7 },
  });
  assert.equal(r.sent, false);
  assert.equal(r.count, 0);
  assert.equal(notified, 0);
});

test("runAmazonDigest notifies when there is spend to report", async () => {
  let msg = null;
  const r = await runAmazonDigest({
    fetch: async () => ({ signedIn: true, orders: ORDERS }),
    notify: async (t) => { msg = t; },
    now: NOW,
    cfg: { pages: 2, sinceDays: 7 },
  });
  assert.equal(r.sent, true);
  assert.equal(r.count, 3);
  assert.match(msg, /\$67\.60 total/);
});
