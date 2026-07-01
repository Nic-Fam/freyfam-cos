import { test } from "node:test";
import assert from "node:assert";
import { parseOrderCard, classifyStatus, isConsumable, isSignInWall } from "../src/amazon-orders.js";

// A representative delivered grocery order card (text as Amazon renders innerText).
const DELIVERED_CARD = {
  text: [
    "ORDER PLACED",
    "June 24, 2026",
    "TOTAL",
    "$48.73",
    "SHIP TO",
    "Nic Frey",
    "ORDER # 112-4455667-8899001",
    "Delivered June 26",
    "Package was handed to resident",
    "Organic Rolled Oats, 32 oz",
    "Buy it again",
  ].join("\n"),
  items: [
    { title: "365 by Whole Foods Organic Rolled Oats, 32 oz", href: "/dp/B00ABC" },
    { title: "Anker USB-C Cable", href: "/gp/product/B00XYZ" },
  ],
};

test("parseOrderCard pulls order id, total, date, status, and delivery line", () => {
  const o = parseOrderCard(DELIVERED_CARD);
  assert.equal(o.orderId, "112-4455667-8899001");
  assert.equal(o.total, "$48.73");
  assert.equal(o.placedDate, "June 24, 2026");
  assert.equal(o.status, "delivered");
  assert.equal(o.deliveryLine, "Delivered June 26");
});

test("parseOrderCard flags consumables per item (chef's pantry beat)", () => {
  const o = parseOrderCard(DELIVERED_CARD);
  const oats = o.items.find((i) => /oats/i.test(i.title));
  const cable = o.items.find((i) => /cable/i.test(i.title));
  assert.equal(oats.consumable, true);   // grocery -> chef
  assert.equal(cable.consumable, false); // electronics -> not chef
});

test("classifyStatus maps the lifecycle keywords", () => {
  assert.equal(classifyStatus("Arriving tomorrow by 9pm"), "arriving");
  assert.equal(classifyStatus("Your package has shipped"), "shipped");
  assert.equal(classifyStatus("Delivered Thursday"), "delivered");
  assert.equal(classifyStatus("Order cancelled"), "cancelled");
  assert.equal(classifyStatus("Return complete, refund issued"), "returned");
  assert.equal(classifyStatus("ORDER PLACED June 1"), "ordered");
  assert.equal(classifyStatus("nothing useful here"), "unknown");
});

test("parseOrderCard is safe on empty/garbage input", () => {
  const o = parseOrderCard({});
  assert.equal(o.orderId, null);
  assert.equal(o.total, null);
  assert.equal(o.status, "unknown");
  assert.deepEqual(o.items, []);
});

test("isConsumable heuristic separates grocery/household from durables", () => {
  assert.ok(isConsumable("Peet's Coffee Dark Roast"));
  assert.ok(isConsumable("Pampers Diapers Size 4"));
  assert.ok(isConsumable("Bounty Paper Towels"));
  assert.ok(!isConsumable("Sony WH-1000XM5 Headphones"));
  assert.ok(!isConsumable("LEGO Star Wars Set"));
});

test("isSignInWall detects the login/captcha redirects", () => {
  assert.ok(isSignInWall("https://www.amazon.com/ap/signin?openid..."));
  assert.ok(isSignInWall("https://www.amazon.com/errors/validateCaptcha"));
  assert.ok(!isSignInWall("https://www.amazon.com/gp/css/order-history"));
});
