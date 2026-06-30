import test from "node:test";
import assert from "node:assert";
import {
  normalizeCompanies,
  renderCompanyPersona,
  cooRoster,
  companySpecialistRoster,
  companyAgentKeys,
  companyAgent,
  isCoo,
  isCompanyAgent,
  FAMILY_SPECIALISTS,
} from "../src/companies.js";
import { persona } from "../src/persona.js";
import { specialistTools, AGENT_ALLOWLIST, CHIEF_ONLY_TOOLS } from "../src/agents/tools.js";
import { KNOWN_AGENTS } from "../src/rules.js";
import { modelForAgent, MODELS } from "../src/config.js";

// A minimal valid roster for the pure-function tests (no file I/O).
const ROSTER = {
  companies: [
    {
      key: "acme",
      company: "Acme",
      business: "Makes anvils.",
      goal: "Sell more anvils.",
      budgetUsd: 50,
      cycle: "monthly",
      allowedSpecialists: ["finance", "dev"],
      specialists: [
        { role: "Sales", focus: "Move anvils." },
        { role: "Community intelligence", focus: "Watch the coyote forums." },
      ],
    },
  ],
};

// --- normalizeCompanies: derivation -----------------------------------------

test("normalizeCompanies derives COO + specialist keys and shape", () => {
  const { companies, coos, companySpecialists, byAgent } = normalizeCompanies(ROSTER);
  assert.equal(companies.length, 1);
  assert.equal(coos.length, 1);
  assert.equal(coos[0].key, "acme-coo");
  assert.equal(coos[0].type, "coo");
  assert.deepEqual(companySpecialists.map((s) => s.key), ["acme-sales", "acme-community-intelligence"]);
  assert.equal(byAgent.get("acme-community-intelligence").type, "specialist");
  assert.equal(byAgent.get("acme-sales").cooKey, "acme-coo");
});

// --- normalizeCompanies: validation fails loudly ----------------------------

test("normalizeCompanies rejects bad config", () => {
  const cases = [
    [{}, /expected a top-level/],
    [{ companies: [{ key: "Bad Key", company: "X", business: "y", budgetUsd: 1 }] }, /lowercase alphanumeric/],
    [{ companies: [{ key: "finance", company: "X", business: "y", budgetUsd: 1 }] }, /reserved/],
    [{ companies: [{ key: "a", company: "X", business: "y", budgetUsd: 0 }] }, /positive budgetUsd/],
    [{ companies: [{ key: "a", company: "", business: "y", budgetUsd: 1 }] }, /display name/],
    [{ companies: [{ key: "a", company: "X", business: "", budgetUsd: 1 }] }, /business/],
    [{ companies: [{ key: "a", company: "X", business: "y", budgetUsd: 1, allowedSpecialists: ["nope"] }] }, /unknown family specialist/],
    [{ companies: [{ key: "a", company: "X", business: "y", budgetUsd: 1, specialists: [{ role: "" }] }] }, /missing "role"/],
    [{ companies: [{ key: "a", company: "X", business: "y", budgetUsd: 1, specialists: [{ role: "Sales" }, { role: "sales" }] }] }, /slugging to "sales"/],
    [{ companies: [{ key: "a", company: "X", business: "y", budgetUsd: 1 }, { key: "a", company: "Y", business: "z", budgetUsd: 1 }] }, /duplicate company key/],
  ];
  for (const [raw, re] of cases) {
    assert.throws(() => normalizeCompanies(raw), re, `should reject ${JSON.stringify(raw)}`);
  }
});

test("allowedSpecialists are a subset of the family specialists", () => {
  const { coos } = normalizeCompanies(ROSTER);
  for (const s of coos[0].allowedSpecialists) assert.ok(FAMILY_SPECIALISTS.includes(s));
});

// --- the real roster file (data/companies.json) -----------------------------

test("the real roster loads with the three confirmed companies", () => {
  const keys = cooRoster().map((c) => c.key);
  assert.deepEqual(keys.sort(), ["dariviant-coo", "pontable-coo", "sasshey-coo"]);
  assert.ok(companySpecialistRoster().length >= 12, "company specialists are registered");
  assert.ok(isCoo("sasshey-coo"));
  assert.ok(isCompanyAgent("dariviant-community-intelligence"));
  assert.ok(!isCoo("dariviant-community-intelligence"));
  assert.ok(!isCompanyAgent("finance"), "a family specialist is not a company agent");
});

test("KNOWN_AGENTS includes the household roster plus every company agent", () => {
  for (const a of ["chief", "finance", "dev", "resale", "chef", "security"]) assert.ok(KNOWN_AGENTS.includes(a));
  for (const k of companyAgentKeys()) assert.ok(KNOWN_AGENTS.includes(k), `KNOWN_AGENTS has ${k}`);
});

// --- persona rendering -------------------------------------------------------

test("COO persona renders the company specifics and its specialist list", async () => {
  const p = await persona("sasshey-coo");
  assert.match(p, /# Sasshey COO/);
  assert.match(p, /Buyer behavior analyst/);
  assert.match(p, /finance \(Patrick\)/); // allowedSpecialists rendered with a friendly label
  assert.doesNotMatch(p, /\{\{\w+\}\}/, "no unfilled placeholders remain");
  // The hard limits must survive into the rendered charter.
  assert.match(p, /NO outbound channel/);
});

test("company-specialist persona renders role + focus + reports up to the COO", async () => {
  const p = await persona("dariviant-community-intelligence");
  assert.match(p, /# Dariviant - Community intelligence/);
  assert.match(p, /the Dariviant COO/);
  assert.doesNotMatch(p, /\{\{\w+\}\}/);
});

test("renderCompanyPersona returns null for a non-company agent", () => {
  assert.equal(renderCompanyPersona("finance"), null);
  assert.equal(renderCompanyPersona("does-not-exist"), null);
});

// --- scoped, side-effect-light toolset (the boundary) -----------------------

test("a COO gets memory + decisions + read-only search, never an outbound tool", () => {
  const names = specialistTools("sasshey-coo").tools.map((t) => t.name);
  for (const n of ["recall_memory", "remember", "log_decision", "list_decisions", "search"]) {
    assert.ok(names.includes(n), `COO has ${n}`);
  }
  for (const n of names) assert.ok(!CHIEF_ONLY_TOOLS.has(n), `COO must not hold chief-only ${n}`);
});

test("a company specialist gets the memory/decision baseline only (no search yet)", () => {
  const { tools, handlers } = specialistTools("pontable-supply-chain");
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ["list_decisions", "log_decision", "recall_memory", "remember"]);
  assert.deepEqual(names.sort(), Object.keys(handlers).sort(), "tools <-> handlers 1:1");
  assert.ok(!names.includes("search"));
});

test("COO-tier model routing reuses the per-agent cost lever (COO=Sonnet, specialist=Haiku)", () => {
  // A COO does manager judgment -> standard (Sonnet), like finance/dev.
  assert.equal(modelForAgent("sasshey-coo"), MODELS.standard);
  // A company specialist surfaces data -> triage (Haiku), like resale/chef.
  assert.equal(modelForAgent("pontable-supply-chain"), MODELS.triage);
  // Family + unknown agents are unchanged by the COO tiering.
  assert.equal(modelForAgent("finance"), MODELS.standard);
  assert.equal(modelForAgent("resale"), MODELS.triage);
  assert.equal(modelForAgent("nobody"), MODELS.standard);
});

test("every company agent is registered in the allowlist with no chief-only tool", () => {
  for (const k of companyAgentKeys()) {
    assert.ok(Array.isArray(AGENT_ALLOWLIST[k]), `${k} has an allowlist`);
    for (const t of AGENT_ALLOWLIST[k]) assert.ok(!CHIEF_ONLY_TOOLS.has(t), `${k} allowlist excludes chief-only ${t}`);
  }
});
