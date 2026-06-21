import { test } from "node:test";
import assert from "node:assert";
import { deriveClothingHint, formatFox } from "../src/fox.js";

test("paint / messy days suggest old or washable clothes", () => {
  assert.match(deriveClothingHint("Finger painting and clay sculpting"), /washable|old/i);
  assert.match(deriveClothingHint("Sensory bin with shaving cream"), /washable|old/i);
});

test("water days suggest a full change of clothes + towel", () => {
  const h = deriveClothingHint("Water table and sprinkler play outside");
  assert.match(h, /change of clothes/i);
  assert.match(h, /towel/i);
});

test("a day with both messy and water play surfaces both hints", () => {
  const h = deriveClothingHint("Morning: painting. Afternoon: splash pool.");
  assert.match(h, /washable|old/i);
  assert.match(h, /change of clothes/i);
});

test("a calm day yields no wardrobe hint", () => {
  assert.equal(deriveClothingHint("Circle time, story, and blocks"), "");
});

test("formatFox renders activities + wardrobe, null when empty", () => {
  assert.equal(formatFox(null), null);
  assert.equal(formatFox({ activities: "", clothingHint: "" }), null);
  const out = formatFox({ themeOrUnit: "Ocean week", activities: "Water table", clothingHint: "pack a full change of clothes and a towel (water play)" });
  assert.match(out, /Fox today \(Ocean week\)/);
  assert.match(out, /Activities: Water table/);
  assert.match(out, /Wardrobe: .*change of clothes/);
});
