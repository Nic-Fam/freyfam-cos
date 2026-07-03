import { test } from "node:test";
import assert from "node:assert";
import { parseOrderCard, classifyStatus, isConsumable, isSignInWall, classifyNeed, summarizeNeeds } from "../src/amazon-orders.js";

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

test("classifyNeed splits needed / discretionary / gray (finance's beat)", () => {
  assert.equal(classifyNeed("Pampers ZZZ Overnight Diapers, Size 7"), "needed");
  assert.equal(classifyNeed("Amazon Basics Dog Pee Pads, 50 Count"), "needed");
  assert.equal(classifyNeed("Antarctic Star Nugget Ice Maker Countertop"), "discretionary");
  assert.equal(classifyNeed("Amazon Fire TV Cube 4K Ultra HD"), "discretionary");
  assert.equal(classifyNeed("KiToyWod 100 Pcs Wooden Train Track Set"), "discretionary");
  assert.equal(classifyNeed("Starbucks K-Cup Coffee Pods, Caramel, 40 Count"), "gray");
  // strong needed signal wins over an incidental discretionary word
  assert.equal(classifyNeed("Childproof Door Lever Lock (safety, no toy needed)"), "needed");
});

test("summarizeNeeds rolls item classes across orders", () => {
  const orders = [
    { orderId: "1", total: "$190.90", placedDate: "Jun 6", items: [{ title: "Nugget Ice Maker Countertop" }] },
    { orderId: "2", total: "$31.65", placedDate: "Jun 25", items: [{ title: "Starbucks K-Cup Coffee Pods" }] },
    { orderId: "3", total: "$43.89", placedDate: "Jun 27", items: [{ title: "Pull-Ups Training Pants" }] },
  ];
  const s = summarizeNeeds(orders);
  assert.equal(s.itemCount, 3);
  assert.equal(s.neededCount, 1);
  assert.equal(s.grayCount, 1);
  assert.equal(s.discretionary.length, 1);
  assert.equal(s.discretionary[0].title, "Nugget Ice Maker Countertop");
});

test("parseOrderCard flags consumables + need per item", () => {
  const o = parseOrderCard(DELIVERED_CARD);
  const oats = o.items.find((i) => /oats/i.test(i.title));
  const cable = o.items.find((i) => /cable/i.test(i.title));
  assert.equal(oats.consumable, true);   // grocery -> chef
  assert.equal(cable.consumable, false); // electronics -> not chef
  assert.equal(oats.need, "needed");     // finance layer present too
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
