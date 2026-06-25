import { test } from "node:test";
import assert from "node:assert";
import { mealsToGroceryItems } from "../src/meal-grocery.js";
import { useItUpSuggestion } from "../src/meals.js";
import { formatDashboard } from "../src/dashboard.js";

test("mealsToGroceryItems collects + dedupes ingredients across meals", () => {
  const meals = [
    { name: "Tacos", ingredients: ["tortillas", "ground beef", "Cheese"] },
    { name: "Quesadillas", ingredients: ["tortillas", "cheese", "salsa"] }, // tortillas/cheese dupe
    { name: "Cereal", ingredients: [] },
  ];
  assert.deepEqual(mealsToGroceryItems(meals), ["tortillas", "ground beef", "Cheese", "salsa"]);
  assert.deepEqual(mealsToGroceryItems([]), []);
});

test("useItUpSuggestion nudges on items expiring within 3 days, soonest first", () => {
  const out = useItUpSuggestion([
    { name: "Spinach", daysUntil: 2 },
    { name: "Milk", daysUntil: 0 },
    { name: "Canned beans", daysUntil: 200 }, // not soon -> excluded
  ]);
  assert.match(out, /Milk \(expired\).*Spinach \(2d\)/);
  assert.ok(!out.includes("beans"));
  assert.equal(useItUpSuggestion([]), "");
});

test("formatDashboard renders present sections, drops empty ones", () => {
  const card = formatDashboard({
    dateLabel: "Wednesday, June 24",
    events: [{ time: "09:00", title: "Standup", who: "Nic" }],
    fox: { activities: "Water play", wardrobe: "swimsuit + towel" },
    meals: [{ mealType: "dinner", name: "Tacos" }],
    tasks: [{ title: "Pay rent", overdue: true }],
    packages: [],
  });
  assert.match(card, /Today — Wednesday, June 24/);
  assert.match(card, /09:00 Standup \(Nic\)/);
  assert.match(card, /Wear: swimsuit \+ towel/);
  assert.match(card, /OVERDUE: Pay rent/);
  assert.ok(!card.includes("Arriving:")); // empty section dropped
});

test("formatDashboard on an empty day says so", () => {
  assert.match(formatDashboard({ dateLabel: "Sunday" }), /clear day/);
});
