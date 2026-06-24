import { test } from "node:test";
import assert from "node:assert";
import { mergeGroceryItems, gatherGroceryItems } from "../src/grocery.js";

test("mergeGroceryItems unions local list + To Do (Alexa) items, deduped case-insensitively", () => {
  const local = [{ item: "Oat milk", quantity: 2, note: "Chobani" }, { item: "eggs" }];
  const todo = ["Bananas", "oat milk", "Paper towels"]; // "oat milk" dupes the local entry
  const merged = mergeGroceryItems(local, todo);
  assert.deepEqual(merged.map((m) => m.item), ["Oat milk", "eggs", "Bananas", "Paper towels"]);
  // Local entry wins on the dup (keeps qty/note + source 'list'); Alexa items tagged 'alexa'.
  assert.equal(merged[0].quantity, 2);
  assert.equal(merged[0].source, "list");
  assert.equal(merged.find((m) => m.item === "Bananas").source, "alexa");
});

test("mergeGroceryItems tolerates empty/missing sources and blank titles", () => {
  assert.deepEqual(mergeGroceryItems(), []);
  assert.deepEqual(mergeGroceryItems([], ["", "  ", "Milk"]).map((m) => m.item), ["Milk"]);
});

test("gatherGroceryItems merges local + injected To Do read; tolerates a Graph failure", async () => {
  const read = async (store) => {
    assert.equal(store, "Ralphs");
    return [{ id: "1", title: "Bananas" }, { id: "2", title: "Milk" }];
  };
  const merged = await gatherGroceryItems({ store: "Ralphs", local: [{ item: "Milk" }], read });
  assert.deepEqual(merged.map((m) => m.item), ["Milk", "Bananas"]); // Milk deduped

  // A Graph hiccup must not drop the local list.
  const failing = async () => { throw new Error("graph down"); };
  const safe = await gatherGroceryItems({ store: "Ralphs", local: [{ item: "Eggs" }], read: failing });
  assert.deepEqual(safe.map((m) => m.item), ["Eggs"]);
});
