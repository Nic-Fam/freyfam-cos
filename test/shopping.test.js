import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-shopping-test.json");
process.env.SHOPPING_PATH = TMP;
const s = await import("../src/shopping.js");
const { specialistTools } = await import("../src/agents/tools.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("add, list, remove", async () => {
  await s.addShoppingItem({ item: "Oat milk", quantity: "2", addedBy: "carmine" });
  await s.addShoppingItem({ item: "Diapers", note: "size 4" });
  const open = await s.listShopping();
  assert.equal(open.length, 2);
  assert.match(s.formatShopping(open), /Oat milk \(2\).*\[carmine\]/s);
  const removed = await s.removeShoppingItem("Oat milk");
  assert.equal(removed.item, "Oat milk");
  assert.equal((await s.listShopping()).length, 1);
});

test("adding the same item again merges (no duplicate), updates qty", async () => {
  await s.addShoppingItem({ item: "eggs" });
  const second = await s.addShoppingItem({ item: "EGGS", quantity: "1 dozen" });
  assert.equal(second.merged, true);
  const open = await s.listShopping();
  assert.equal(open.length, 1);
  assert.equal(open[0].quantity, "1 dozen");
});

test("clearShopping empties the list", async () => {
  await s.addShoppingItem({ item: "a" });
  await s.addShoppingItem({ item: "b" });
  assert.equal(await s.clearShopping(), 2);
  assert.equal((await s.listShopping()).length, 0);
});

test("Carmine (chef) can add to the shopping list", () => {
  const tools = specialistTools("chef").tools.map((t) => t.name);
  assert.ok(tools.includes("add_shopping_item") && tools.includes("list_shopping"));
});
