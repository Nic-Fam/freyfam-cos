import test from "node:test";
import assert from "node:assert";
import {
  normalizeDate, normalizeMealType, mealOrderIndex, sortByMealOrder,
  formatMealLine, formatMealsContext, estimateExpiration, daysUntil, VALID_MEAL_TYPES,
} from "../src/meals.js";

test("normalizeDate passes through ISO dates and rejects junk", () => {
  assert.equal(normalizeDate("2026-06-18"), "2026-06-18");
  assert.equal(normalizeDate("not a date"), null);
  assert.equal(normalizeDate(null), null);
});

test("normalizeMealType lowercases valid types and throws on bad ones", () => {
  assert.equal(normalizeMealType("Dinner"), "dinner");
  assert.throws(() => normalizeMealType("brunch"));
  assert.deepEqual(VALID_MEAL_TYPES, ["breakfast", "lunch", "dinner", "snack"]);
});

test("meal ordering sorts breakfast -> lunch -> dinner -> snack", () => {
  assert.ok(mealOrderIndex("breakfast") < mealOrderIndex("dinner"));
  const sorted = sortByMealOrder([
    { mealType: "dinner" }, { mealType: "breakfast" }, { mealType: "snack" }, { mealType: "lunch" },
  ]).map((m) => m.mealType);
  assert.deepEqual(sorted, ["breakfast", "lunch", "dinner", "snack"]);
});

test("formatMealLine renders prep + notes, no em dashes", () => {
  const line = formatMealLine({ mealType: "dinner", name: "Salmon", prepMinutes: 20, notes: "thaw early" });
  assert.ok(line.startsWith("Dinner: Salmon"));
  assert.ok(line.includes("20 min prep"));
  assert.ok(line.includes("thaw early"));
  assert.ok(!line.includes("—"), "no em dash");
});

test("formatMealsContext groups by date; null when empty", () => {
  assert.equal(formatMealsContext([]), null);
  const ctx = formatMealsContext([
    { date: "2026-06-20", mealType: "dinner", name: "Tacos" },
    { date: "2026-06-20", mealType: "breakfast", name: "Oatmeal" },
  ]);
  assert.ok(ctx.includes("2026-06-20:"));
  // breakfast should render before dinner within the day
  assert.ok(ctx.indexOf("Oatmeal") < ctx.indexOf("Tacos"));
});

test("estimateExpiration shortens when opened; daysUntil signs correctly", () => {
  const added = "2026-06-01T00:00:00.000Z";
  const sealed = estimateExpiration({ category: "dairy", opened: false, addedAt: added });
  const opened = estimateExpiration({ category: "dairy", opened: true, addedAt: added, openedAt: added });
  assert.ok(opened < sealed, "opened dairy expires sooner than sealed");
  assert.ok(daysUntil("1999-01-01") < 0, "past date is negative");
  assert.equal(daysUntil(null), null);
});
