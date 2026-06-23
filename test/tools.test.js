import test from "node:test";
import assert from "node:assert";
import { specialistTools, AGENT_ALLOWLIST, CHIEF_ONLY_TOOLS } from "../src/agents/tools.js";

test("each specialist exposes scoped memory tools, all with handlers + valid schemas", () => {
  for (const agent of ["finance", "resale", "dev", "chef", "security"]) {
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
  const chef = specialistTools("chef").tools.map((t) => t.name);
  for (const n of ["view_meal_plan", "plan_meal", "remove_meal", "kitchen_inventory", "inventory_summary", "expiring_soon", "add_inventory_item", "consume_inventory_item"]) {
    assert.ok(chef.includes(n), `chef has ${n}`);
  }
  const security = specialistTools("security").tools.map((t) => t.name);
  for (const n of ["log_security_finding", "list_security_findings"]) {
    assert.ok(security.includes(n), `security has ${n}`);
  }
});

test("unknown agent returns an empty toolset", () => {
  const { tools, handlers } = specialistTools("nope");
  assert.equal(tools.length, 0);
  assert.deepEqual(handlers, {});
});

// --- allowlist as an enforced boundary (workstream K#4) --------------------

test("every assembled tool + handler stays within the agent's allowlist", () => {
  for (const agent of Object.keys(AGENT_ALLOWLIST)) {
    const allow = new Set(AGENT_ALLOWLIST[agent]);
    const { tools, handlers } = specialistTools(agent);
    for (const t of tools) assert.ok(allow.has(t.name), `${agent} tool ${t.name} is within its allowlist`);
    for (const name of Object.keys(handlers)) assert.ok(allow.has(name), `${agent} handler ${name} is within its allowlist`);
    // Tools and handlers correspond 1:1 (no tool without a handler or vice versa).
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(handlers).sort(), `${agent} tools<->handlers`);
  }
});

test("no specialist may hold a chief-only (outbound/high-stakes) tool", () => {
  for (const agent of Object.keys(AGENT_ALLOWLIST)) {
    const { tools } = specialistTools(agent);
    for (const t of tools) assert.ok(!CHIEF_ONLY_TOOLS.has(t.name), `${agent} must not expose chief-only ${t.name}`);
    for (const name of AGENT_ALLOWLIST[agent]) assert.ok(!CHIEF_ONLY_TOOLS.has(name), `${agent} allowlist excludes chief-only ${name}`);
  }
});

test("finance stays locked down: analysis only, no search/browse/outbound", () => {
  const finance = specialistTools("finance").tools.map((t) => t.name);
  assert.ok(finance.includes("analyze_transactions"));
  assert.ok(!finance.includes("search"), "finance has no web search (Finn's lockdown)");
  assert.ok(!finance.some((n) => CHIEF_ONLY_TOOLS.has(n)), "finance has no outbound tool");
});

test("an allowlist naming a chief-only tool is a hard misconfiguration (throws)", () => {
  AGENT_ALLOWLIST.finance.push("send_email"); // simulate a bad future edit
  try {
    assert.throws(() => specialistTools("finance"), /chief-only tool "send_email"/);
  } finally {
    AGENT_ALLOWLIST.finance.pop(); // restore so later tests are unaffected
  }
});
