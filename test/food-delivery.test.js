import { test } from "node:test";
import assert from "node:assert";
import {
  normalizeProvider, providerKeys, findFoodOrders, resolveReorder,
  formatFoodOrders, formatReorder, placeFoodOrder, readOrderHistory,
} from "../src/food-delivery.js";

// Injected order history (what the live browser read would return, newest last on
// purpose so the sort is exercised).
const HISTORY = [
  { provider: "doordash", restaurant: "Pizzana", date: "2026-05-01", total: 41.2, url: "https://www.doordash.com/orders/aaa",
    items: [{ name: "Margherita Pizza", quantity: 1 }, { name: "Caesar Salad", quantity: 1 }] },
  { provider: "doordash", restaurant: "Sushi Note", date: "2026-06-20", total: 88.5, url: "https://www.doordash.com/orders/bbb",
    items: [{ name: "Omakase for two", quantity: 1 }] },
  { provider: "doordash", restaurant: "Pizzana", date: "2026-07-02", total: 44.0, url: "https://www.doordash.com/orders/ccc",
    items: [{ name: "Margherita Pizza", quantity: 2 }, { name: "Garlic Knots", quantity: 1 }] },
];

test("normalizeProvider maps known names + aliases, rejects unknown", () => {
  assert.equal(normalizeProvider("DoorDash"), "doordash");
  assert.equal(normalizeProvider("postmates"), "postmates");
  assert.equal(normalizeProvider("uber eats"), "postmates");
  assert.equal(normalizeProvider("ubereats"), "postmates");
  assert.equal(normalizeProvider("grubhub"), null);
  assert.equal(normalizeProvider(""), null);
  assert.deepEqual(providerKeys().sort(), ["doordash", "postmates"]);
});

test("findFoodOrders filters by restaurant (fuzzy) and sorts newest first", async () => {
  const hits = await findFoodOrders({ restaurant: "pizzana", history: HISTORY });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].date, "2026-07-02"); // most recent Pizzana first
  assert.ok(hits.every((h) => h.restaurant === "Pizzana"));
});

test("findFoodOrders with no restaurant returns all, newest first", async () => {
  const all = await findFoodOrders({ history: HISTORY });
  assert.equal(all.length, 3);
  assert.equal(all[0].date, "2026-07-02");
  assert.equal(all[all.length - 1].date, "2026-05-01");
});

test("findFoodOrders respects limit", async () => {
  const one = await findFoodOrders({ history: HISTORY, limit: 1 });
  assert.equal(one.length, 1);
  assert.equal(one[0].date, "2026-07-02");
});

test("resolveReorder picks the most recent match for 'last'", async () => {
  const { order, cartItems } = await resolveReorder({ restaurant: "Pizzana", which: "last", history: HISTORY });
  assert.equal(order.date, "2026-07-02");
  assert.equal(order.url, "https://www.doordash.com/orders/ccc");
  assert.equal(cartItems.length, 2);
  assert.equal(cartItems[0].quantity, 2);
});

test("resolveReorder picks the Nth most recent when which=number", async () => {
  const { order } = await resolveReorder({ restaurant: "Pizzana", which: "2", history: HISTORY });
  assert.equal(order.date, "2026-05-01"); // 2nd most recent Pizzana
});

test("resolveReorder returns a reason (no order) when nothing matches", async () => {
  const { order, reason } = await resolveReorder({ restaurant: "Nobu", history: HISTORY });
  assert.equal(order, null);
  assert.match(reason, /No past order found from "Nobu"/);
});

test("formatFoodOrders is a clean numbered list with items, no em dashes", () => {
  const listed = formatFoodOrders([HISTORY[2], HISTORY[0]]); // formats in the given order
  assert.match(listed, /1\. Pizzana/);
  assert.match(listed, /Margherita Pizza/);
  assert.match(listed, /DoorDash/);
  assert.ok(!listed.includes("—")); // no em dash (family style)
  assert.equal(formatFoodOrders([]), "No matching past orders found.");
});

test("formatReorder shows itemized cart, provider, address, no em dashes", () => {
  const s = formatReorder(HISTORY[2], { address: "home" });
  assert.match(s, /Reorder from Pizzana via DoorDash/);
  assert.match(s, /2x Margherita Pizza/);
  assert.match(s, /delivered to home/);
  assert.ok(!s.includes("—"));
});

test("placeFoodOrder falls back to manual placement when no steps are captured", async () => {
  // No steps file for a fresh provider path -> manual fallback, never a fake checkout.
  let ran = false;
  const msg = await placeFoodOrder(
    { provider: "doordash", restaurant: "Pizzana", items: HISTORY[2].items, total: 44 },
    { run: async () => { ran = true; return { transcript: [] }; } }
  );
  assert.match(msg, /isn't set up yet|manually/);
  assert.equal(ran, false); // did not attempt a real checkout
});

test("placeFoodOrder runs steps when provided (injected run + steps path)", async () => {
  // Write the steps fixture to a temp file (not into the repo tree) and clean it up.
  const { writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const { join } = await import("node:path");
  const stepsPath = join(os.tmpdir(), "cos-food-steps-test.json");
  process.env.DOORDASH_STEPS_PATH = stepsPath;
  await writeFile(stepsPath, JSON.stringify({ steps: [{ action: "goto", url: "https://www.doordash.com/orders/ccc" }] }));
  try {
    let calledWith = null;
    const msg = await placeFoodOrder(
      { provider: "doordash", restaurant: "Pizzana", url: "https://www.doordash.com/orders/ccc", items: [] },
      { run: async (a) => { calledWith = a; return { transcript: ["goto https://www.doordash.com/orders/ccc"] }; } }
    );
    assert.ok(calledWith, "run was called");
    assert.equal(calledWith.url, "https://www.doordash.com/orders/ccc");
    assert.match(msg, /DoorDash order placed for Pizzana/);
  } finally {
    await rm(stepsPath, { force: true });
    delete process.env.DOORDASH_STEPS_PATH;
  }
});

test("placeFoodOrder rejects an unknown provider without ordering", async () => {
  let ran = false;
  const msg = await placeFoodOrder({ provider: "grubhub", restaurant: "X" }, { run: async () => { ran = true; return {}; } });
  assert.match(msg, /Unknown delivery provider/);
  assert.equal(ran, false);
});

test("readOrderHistory is best-effort: swallows a failing read into []", async () => {
  const rows = await readOrderHistory({ provider: "doordash", read: async () => { throw new Error("no browser"); } });
  assert.deepEqual(rows, []);
  const none = await readOrderHistory({ provider: "grubhub", read: async () => ({ items: [] }) });
  assert.deepEqual(none, []);
});
