import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { startStoreOrder, placeStoreOrder, markListItemsDone, formatCartForApproval } from "../src/store-order.js";
import { buildGroceryPlaybook, configuredDeliveryAddress } from "../src/grocery-order-playbook.js";

beforeEach(() => {
  process.env.COS_BROWSER_AGENT = "true";
  process.env.HOME_DELIVERY_HINT = "1 Test Ln";
  delete process.env.COSTCO_DELIVERY_HINT;
});

const filled = { ok: true, store: "costco", phase: "fill", added: [{ item: "Kirkland Eggs 24ct", qty: 1 }, { item: "Bananas", qty: 2 }], dropped: ["oat milk"], total: 41.2, window: "Today 4-6pm" };

test("fill run stages the real cart for approval and never commits", async () => {
  let ran, staged;
  const msg = await startStoreOrder("costco", {
    deps: {
      gather: async () => [{ item: "eggs" }, { item: "bananas" }, { item: "oat milk" }],
      run: async (o) => { ran = o; return { ok: true, result: filled, turns: 20 }; },
      stage: async (desc, kind, params) => { staged = { desc, kind, params }; },
    },
  });
  assert.equal(ran.allowCommit, false);
  assert.deepEqual(ran.allowedHosts, ["instacart.com"]);
  assert.match(ran.task, /DO NOT place/i);
  assert.doesNotMatch(ran.task, /list_connected_browsers/); // agent mode, not Claude-in-Chrome
  assert.equal(staged.kind, "store_order");
  assert.equal(staged.params.total, 41.2);
  assert.match(staged.desc, /Out of stock, left off: oat milk/);
  assert.match(msg, /Sent for approval/);
});

test("fill failure notifies and stages nothing", async () => {
  let staged = false, note;
  const msg = await startStoreOrder("costco", {
    deps: {
      gather: async () => [{ item: "eggs" }],
      run: async () => ({ ok: false, result: { ok: false, reason: "not_signed_in" } }),
      stage: async () => { staged = true; },
      notify: async (m) => { note = m; },
    },
  });
  assert.equal(staged, false);
  assert.match(msg, /fresh sign-in/);
  assert.equal(note, msg);
});

test("over-cap cart is refused even when the agent says ok", async () => {
  let staged = false;
  const msg = await startStoreOrder("costco", {
    deps: {
      gather: async () => [{ item: "tv" }],
      run: async () => ({ ok: true, result: { ...filled, total: 9000 } }),
      stage: async () => { staged = true; },
    },
  });
  assert.equal(staged, false);
  assert.match(msg, /over the/);
});

test("disabled agent and empty list short-circuit", async () => {
  process.env.COS_BROWSER_AGENT = "false";
  assert.match(await startStoreOrder("costco", { deps: { stage: async () => {} } }), /isn't switched on/);
  process.env.COS_BROWSER_AGENT = "true";
  assert.match(await startStoreOrder("costco", { deps: { gather: async () => [], stage: async () => {} } }), /empty/);
  assert.match(await startStoreOrder("target", { deps: { stage: async () => {} } }), /only order from/);
});

test("submit run may commit, checks the approved total, and clears only ordered items", async () => {
  let ran, cleared;
  const msg = await placeStoreOrder(
    { store: "costco", items: ["eggs", "bananas", "oat milk"], added: filled.added, dropped: ["oat milk"], total: 41.2 },
    {
      deps: {
        run: async (o) => { ran = o; return { ok: true, result: { ok: true, store: "costco", orderNumber: "A1", total: 44.1, window: "Today 4-6pm" } }; },
        markDone: async (list, titles) => { cleared = { list, titles }; },
      },
    }
  );
  assert.equal(ran.allowCommit, true);
  assert.match(ran.task, /PLACE the/);
  assert.match(ran.task, /approved \$41\.20/);
  assert.deepEqual(cleared, { list: "Costco", titles: ["eggs", "bananas"] });
  assert.match(msg, /order placed \(#A1\): \$44\.10/);
});

test("submit failure reports it was NOT placed", async () => {
  const msg = await placeStoreOrder({ store: "costco", added: [], total: 10 }, {
    deps: { run: async () => ({ ok: false, result: { ok: false, reason: "cart_changed", notes: "price went up" } }), markDone: async () => assert.fail("should not clear") },
  });
  assert.match(msg, /did NOT place/);
});

test("markListItemsDone completes matching To Do tasks only", async () => {
  const done = [];
  const n = await markListItemsDone("Costco", ["Eggs"], {
    list: async () => [{ id: "1", title: "eggs", listId: "L" }, { id: "2", title: "milk", listId: "L" }],
    complete: async (l, id) => done.push(id),
  });
  assert.equal(n, 1);
  assert.deepEqual(done, ["1"]);
});

test("costco playbook delivers home by default, honors a per-store override; formatCartForApproval reads well", () => {
  let p = buildGroceryPlaybook({ store: "costco", phase: "fill", items: [{ item: "eggs" }], operator: "agent" });
  assert.match(p, /1 Test Ln/);
  process.env.COSTCO_DELIVERY_HINT = "9 Override Way";
  p = buildGroceryPlaybook({ store: "costco", phase: "fill", items: [{ item: "eggs" }], operator: "agent" });
  assert.match(p, /9 Override Way/);
  delete process.env.COSTCO_DELIVERY_HINT;
  assert.match(formatCartForApproval("costco", filled), /Costco cart is ready \(2 items, \$41\.20, Today 4-6pm\)/);
});

test("configuredDeliveryAddress: home for every store, costco override, null when unset or blank", () => {
  assert.equal(configuredDeliveryAddress("ralphs"), "1 Test Ln");
  assert.equal(configuredDeliveryAddress("costco"), "1 Test Ln");
  process.env.COSTCO_DELIVERY_HINT = "9 Override Way";
  assert.equal(configuredDeliveryAddress("costco"), "9 Override Way");
  assert.equal(configuredDeliveryAddress("ralphs"), "1 Test Ln");
  process.env.HOME_DELIVERY_HINT = "   ";
  delete process.env.COSTCO_DELIVERY_HINT;
  assert.equal(configuredDeliveryAddress("ralphs"), null);
  assert.equal(configuredDeliveryAddress("costco"), null);
});

test("no delivery address configured: fill refuses before touching the browser", async () => {
  delete process.env.HOME_DELIVERY_HINT;
  let ran = false, staged = false;
  const msg = await startStoreOrder("ralphs", {
    deps: {
      gather: async () => [{ item: "milk" }],
      run: async () => { ran = true; return { ok: true, result: filled }; },
      stage: async () => { staged = true; },
    },
  });
  assert.equal(ran, false);
  assert.equal(staged, false);
  assert.match(msg, /won't build the cart/);
  assert.doesNotMatch(msg, /\u2014/); // no em dashes in family copy
});

test("no delivery address configured: an approved order is not placed", async () => {
  delete process.env.HOME_DELIVERY_HINT;
  let ran = false;
  const msg = await placeStoreOrder({ store: "costco", added: [{ item: "Eggs", qty: 1 }], total: 10 }, {
    deps: { run: async () => { ran = true; return { ok: true, result: { ok: true } }; }, markDone: async () => assert.fail("should not clear") },
  });
  assert.equal(ran, false);
  assert.match(msg, /did NOT place/);
});
