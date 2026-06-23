import { test } from "node:test";
import assert from "node:assert";
import { shouldRunGroceryOrder, assembleOrder, applyAvailability, formatOrder } from "../src/grocery.js";

const opts = { weekday: 5, hour: 9, windowHours: 5, tz: "America/Los_Angeles" };

test("fires Friday morning, once per day", () => {
  // 2026-06-26 is a Friday. 17:00 UTC = 10:00 AM PDT -> inside [9,14).
  const fri = new Date("2026-06-26T17:00:00Z");
  const r = shouldRunGroceryOrder(fri, null, opts);
  assert.equal(r.run, true);
  assert.equal(r.date, "2026-06-26");
  assert.equal(shouldRunGroceryOrder(fri, "2026-06-26", opts).run, false); // already ran today
});

test("does not fire on a non-Friday or outside the window", () => {
  assert.equal(shouldRunGroceryOrder(new Date("2026-06-25T17:00:00Z"), null, opts).run, false); // Thursday
  assert.equal(shouldRunGroceryOrder(new Date("2026-06-26T05:00:00Z"), null, opts).run, false); // Fri but ~10pm Thu PT / before window
});

test("assembleOrder applies the 4x fuel-points coupon and Friday-evening delivery", () => {
  const o = assembleOrder([{ item: "Oat milk", quantity: 2 }, { item: "Eggs" }]); // default coupons/delivery
  assert.equal(o.count, 2);
  assert.deepEqual(o.coupons, ["4x fuel points"]);
  assert.equal(o.deliveryWindow, "Friday evening");
  assert.match(formatOrder(o), /4x fuel points/);
});

test("out-of-stock policy drops unavailable items so the order completes", () => {
  const items = [{ item: "Oat milk" }, { item: "Salmon" }, { item: "Eggs" }];
  const { kept, dropped } = applyAvailability(items, ["salmon"]); // case-insensitive
  assert.deepEqual(kept.map((i) => i.item), ["Oat milk", "Eggs"]);
  assert.deepEqual(dropped.map((i) => i.item), ["Salmon"]);
});
