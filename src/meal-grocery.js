// Meal plan -> grocery list (the kitchen<->grocery close-the-loop). Turns a set of
// planned meals into a deduped ingredient list, which Lloyd writes onto the Ralphs
// To Do list (the same list the Friday order reads). So "plan the week's dinners"
// auto-populates the shopping list. Pure + testable; the To Do write lives on Lloyd
// (orchestrator tool) since specialists have no outbound side-effects.

/**
 * Collect a deduped grocery list from planned meals' ingredients (case-insensitive),
 * preserving first-seen order. Meals without ingredients contribute nothing. Pure.
 * @param {Array<{name?:string, ingredients?:string[]}>} meals
 * @returns {string[]}
 */
export function mealsToGroceryItems(meals = []) {
  const seen = new Set();
  const out = [];
  for (const m of meals || []) {
    for (const ing of m?.ingredients || []) {
      const name = String(ing || "").trim();
      const key = name.toLowerCase();
      if (name && !seen.has(key)) {
        seen.add(key);
        out.push(name);
      }
    }
  }
  return out;
}
