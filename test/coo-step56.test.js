import { test } from "node:test";
import assert from "node:assert";
import { cooRoster, companySpecialistRoster } from "../src/companies.js";
import {
  companySpecialistAllowlist, companySpecialistGrantsSearch,
  AGENT_ALLOWLIST, CHIEF_ONLY_TOOLS, specialistTools,
} from "../src/agents/tools.js";

// --- Step 5: per-company autonomous-review opt-in ---------------------------
test("step5: reviewEnabled is per-company — Sasshey on, others dark", () => {
  const coos = cooRoster();
  const sasshey = coos.find((c) => c.companyKey === "sasshey");
  assert.ok(sasshey, "sasshey COO exists in the roster");
  assert.equal(sasshey.reviewEnabled, true, "Sasshey is the first live COO");
  for (const c of coos) {
    if (c.companyKey !== "sasshey") assert.equal(c.reviewEnabled, false, `${c.companyKey} must stay dark`);
  }
});

// --- Step 6: role-specific company-specialist tools ------------------------
test("step6: search granted to research roles, withheld from internal-data roles", () => {
  assert.equal(companySpecialistGrantsSearch("marketing"), true);
  assert.equal(companySpecialistGrantsSearch("community-intelligence"), true);
  assert.equal(companySpecialistGrantsSearch("buyer-behavior-analyst"), true);
  assert.equal(companySpecialistGrantsSearch("inventory"), false);
  assert.equal(companySpecialistGrantsSearch("orders"), false);
  assert.deepEqual(companySpecialistAllowlist("marketing"), ["recall_memory", "remember", "log_decision", "list_decisions", "search"]);
  assert.deepEqual(companySpecialistAllowlist("inventory"), ["recall_memory", "remember", "log_decision", "list_decisions"]);
});

test("step6: every company-specialist allowlist is baseline(+search) and never chief-only", () => {
  const specs = companySpecialistRoster();
  assert.ok(specs.length > 0);
  for (const s of specs) {
    const allow = AGENT_ALLOWLIST[s.key];
    assert.ok(Array.isArray(allow), `${s.key} has an allowlist`);
    for (const t of allow) assert.equal(CHIEF_ONLY_TOOLS.has(t), false, `${s.key} must never hold chief-only "${t}"`);
    assert.equal(allow.includes("search"), companySpecialistGrantsSearch(s.slug), `${s.key} search matches its role`);
  }
});

test("step6: specialistTools assembles the right tools per role", () => {
  const mkt = companySpecialistRoster().find((s) => s.slug === "marketing");
  const inv = companySpecialistRoster().find((s) => s.slug === "inventory");
  const mktTools = specialistTools(mkt.key).tools.map((t) => t.name);
  const invTools = specialistTools(inv.key).tools.map((t) => t.name);
  assert.ok(mktTools.includes("search"), "marketing gets search");
  assert.ok(!invTools.includes("search"), "inventory does not");
  for (const t of ["recall_memory", "remember", "log_decision", "list_decisions"]) {
    assert.ok(mktTools.includes(t) && invTools.includes(t), `both keep baseline ${t}`);
  }
});
