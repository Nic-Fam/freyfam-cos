import test from "node:test";
import assert from "node:assert";
import { specialistTools } from "../src/agents/tools.js";

test("each specialist exposes scoped memory tools, all with handlers + valid schemas", () => {
  for (const agent of ["finance", "resale", "dev", "carmen"]) {
    const { tools, handlers } = specialistTools(agent);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes("recall_memory"), `${agent} has recall_memory`);
    assert.ok(names.includes("remember"), `${agent} has remember`);
    for (const t of tools) {
      assert.equal(t.input_schema.type, "object", `${agent}.${t.name} schema`);
      assert.equal(typeof handlers[t.name], "function", `${agent}.${t.name} handler`);
    }
  }
});

test("domain tools are registered per specialist", () => {
  assert.ok(specialistTools("finance").tools.some((t) => t.name === "analyze_transactions"));
  const resale = specialistTools("resale").tools.map((t) => t.name);
  for (const n of ["add_saved_search", "list_saved_searches", "remove_saved_search"]) {
    assert.ok(resale.includes(n), `resale has ${n}`);
  }
  assert.ok(specialistTools("dev").tools.some((t) => t.name === "propose_change"));
  const carmen = specialistTools("carmen").tools.map((t) => t.name);
  for (const n of ["view_meal_plan", "plan_meal", "remove_meal", "kitchen_inventory", "inventory_summary", "expiring_soon", "add_inventory_item", "consume_inventory_item"]) {
    assert.ok(carmen.includes(n), `carmen has ${n}`);
  }
});

test("unknown agent returns an empty toolset", () => {
  const { tools, handlers } = specialistTools("nope");
  assert.equal(tools.length, 0);
  assert.deepEqual(handlers, {});
});
