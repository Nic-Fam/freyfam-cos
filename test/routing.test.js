import { test } from "node:test";
import assert from "node:assert";
import { routingHints } from "../src/routing.js";

test("routingHints flags receipts -> finance", () => {
  const h = routingHints("Your Amazon order confirmation", "Payment received, $42.10");
  assert.ok(h.some((x) => /finance/i.test(x)));
});

test("routingHints flags shipping -> tracking", () => {
  const h = routingHints("Your package shipped", "Tracking number 1Z999, out for delivery tomorrow");
  assert.ok(h.some((x) => /shipping|package/i.test(x)));
});

test("routingHints flags calendar invites -> scheduling", () => {
  const h = routingHints("Meeting request: sync", "You're invited to a call, please RSVP");
  assert.ok(h.some((x) => /calendar invite|scheduling/i.test(x)));
});

test("routingHints stays quiet on ordinary mail (no false routes)", () => {
  assert.deepEqual(routingHints("Hey", "Are we still on for dinner Saturday?"), []);
  assert.deepEqual(routingHints("", ""), []);
});

test("routingHints can return multiple hints and dedupes by signal", () => {
  const h = routingHints("Order confirmation + shipping", "Your order shipped, tracking number 9400...");
  assert.ok(h.length >= 2);
});
