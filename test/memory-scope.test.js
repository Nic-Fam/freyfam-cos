import test from "node:test";
import assert from "node:assert";
import { memoryPoolFor } from "../src/memory.js";

const items = [
  { text: "household: rent is due the 1st", meta: {} },              // unscoped (household)
  { text: "household: Fox naps at noon", meta: { agent: undefined } }, // unscoped
  { text: "finance: card statement balance", meta: { agent: "finance" } },
  { text: "sasshey-coo: goal is wardrobe inventory", meta: { agent: "sasshey-coo" } },
  { text: "sasshey-sales: pipeline note", meta: { agent: "sasshey-sales" } },
];
const texts = (pool) => pool.map((p) => p.text);

test("chief (no agent) sees everything", () => {
  assert.equal(memoryPoolFor(items, undefined).length, items.length);
});

test("a family specialist sees its own + unscoped household facts", () => {
  const pool = texts(memoryPoolFor(items, "finance"));
  assert.ok(pool.includes("finance: card statement balance"));
  assert.ok(pool.includes("household: rent is due the 1st"), "family agents keep household context");
  assert.ok(!pool.includes("sasshey-coo: goal is wardrobe inventory"), "but not another agent's memories");
});

test("a COO is walled off from household facts (own memories only)", () => {
  const pool = texts(memoryPoolFor(items, "sasshey-coo"));
  assert.deepEqual(pool, ["sasshey-coo: goal is wardrobe inventory"]);
});

test("a company specialist is walled off too", () => {
  const pool = texts(memoryPoolFor(items, "sasshey-sales"));
  assert.deepEqual(pool, ["sasshey-sales: pipeline note"]);
  assert.ok(!pool.some((t) => t.startsWith("household")), "no household bleed");
});
