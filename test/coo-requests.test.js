import test from "node:test";
import assert from "node:assert";
import { requestHandlers, requestToolDefs, REQUEST_TOOL_NAMES, fulfillCooRequests, resolveRequestedSpecialist } from "../src/coo-requests.js";
import { specialistTools } from "../src/agents/tools.js";
import { companyAgent } from "../src/companies.js";

// --- the request tools as a COO-only surface --------------------------------

test("a COO holds the three request tools; a company specialist does not", () => {
  const cooTools = specialistTools("sasshey-coo").tools.map((t) => t.name);
  for (const n of REQUEST_TOOL_NAMES) assert.ok(cooTools.includes(n), `COO has ${n}`);
  const specTools = specialistTools("sasshey-inventory").tools.map((t) => t.name);
  for (const n of REQUEST_TOOL_NAMES) assert.ok(!specTools.includes(n), `specialist must NOT have ${n}`);
});

test("requestToolDefs are well-formed and 1:1 with the handlers", () => {
  const defs = requestToolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), [...REQUEST_TOOL_NAMES].sort());
  const handlers = requestHandlers([]);
  for (const d of defs) {
    assert.equal(d.input_schema.type, "object");
    assert.equal(typeof handlers[d.name], "function");
  }
});

// --- handlers push structured requests onto the collector -------------------

test("request handlers push the right shapes onto the per-run collector", async () => {
  const requests = [];
  const h = requestHandlers(requests);
  await h.request_specialist({ specialist: "Dev", task: "wire the cart" });
  await h.request_heavy_lift({ brief: "rebuild the catalog importer", why: "current one is flaky" });
  await h.request_action({ action: "send launch email", detail: "to the member list" });
  assert.deepEqual(requests, [
    { type: "specialist", specialist: "dev", task: "wire the cart" }, // normalized lowercase
    { type: "heavy_lift", brief: "rebuild the catalog importer", why: "current one is flaky" },
    { type: "action", action: "send launch email", detail: "to the member list" },
  ]);
});

// --- fulfillment routing (Lloyd's side), with injected deps -----------------

function harness() {
  const delegated = [];
  const staged = [];
  const delegate = async ({ agent, task }) => { delegated.push({ agent, task }); return { text: `did:${task}`, requests: [] }; };
  const requestConfirmation = async (action, kind, params) => { staged.push({ kind, params }); return { code: "AB12", instruction: 'Reply "YES AB12".' }; };
  return { delegated, staged, delegate, requestConfirmation };
}

test("request_specialist delegates only to an allowed family specialist", async () => {
  const coo = companyAgent("sasshey-coo"); // allowedSpecialists: finance, dev, resale
  const { delegated, staged, delegate, requestConfirmation } = harness();
  const summary = await fulfillCooRequests(
    coo,
    [
      { type: "specialist", specialist: "dev", task: "wire the cart" },
      { type: "specialist", specialist: "security", task: "audit it" }, // NOT allowed for sasshey
    ],
    { delegate, requestConfirmation }
  );
  assert.deepEqual(delegated, [{ agent: "dev", task: "wire the cart" }], "only the allowed specialist is delegated");
  assert.match(summary, /did:wire the cart/);
  assert.match(summary, /"security" is neither a Sasshey specialist/);
  assert.equal(staged.length, 0, "specialist requests are not gated");
});

test("request_specialist can reach the COO's OWN company specialists by role", async () => {
  const coo = companyAgent("sasshey-coo");
  const { delegated, staged, delegate, requestConfirmation } = harness();
  const summary = await fulfillCooRequests(
    coo,
    [
      { type: "specialist", specialist: "sales", task: "pipeline snapshot" },        // own, by slug
      { type: "specialist", specialist: "buyer behavior analyst", task: "demand" },  // own, by role name -> slug
    ],
    { delegate, requestConfirmation }
  );
  assert.deepEqual(delegated, [
    { agent: "sasshey-sales", task: "pipeline snapshot" },
    { agent: "sasshey-buyer-behavior-analyst", task: "demand" },
  ], "own specialists resolve to their company-agent keys");
  assert.match(summary, /Sales \(Sasshey specialist\)/);
  assert.equal(staged.length, 0, "consulting your own team is not gated");
});

test("resolveRequestedSpecialist maps family, own-by-slug, own-by-role, and unknown", () => {
  const coo = companyAgent("sasshey-coo");
  assert.deepEqual(resolveRequestedSpecialist(coo, "dev"), { agentKey: "dev", label: "dev" });
  assert.equal(resolveRequestedSpecialist(coo, "inventory").agentKey, "sasshey-inventory");
  assert.equal(resolveRequestedSpecialist(coo, "Sales").agentKey, "sasshey-sales");
  assert.equal(resolveRequestedSpecialist(coo, "nope"), null);
});

test("request_heavy_lift and request_action stage gated approvals (never auto-run)", async () => {
  const coo = companyAgent("dariviant-coo");
  const { delegated, staged, delegate, requestConfirmation } = harness();
  const summary = await fulfillCooRequests(
    coo,
    [
      { type: "heavy_lift", brief: "design the fitment DB", why: "scale" },
      { type: "action", action: "email the supplier", detail: "ask for a quote" },
    ],
    { delegate, requestConfirmation }
  );
  assert.equal(delegated.length, 0, "nothing delegated");
  assert.deepEqual(staged.map((s) => s.kind), ["heavy_lift", "coo_action"], "both routed through the gate");
  assert.equal(staged[0].params.coo, "dariviant-coo");
  assert.equal(staged[1].params.company, "Dariviant");
  assert.match(summary, /staged for your approval/);
  assert.match(summary, /staged for approval/);
});

test("no requests -> empty summary", async () => {
  const coo = companyAgent("pontable-coo");
  const { delegate, requestConfirmation } = harness();
  assert.equal(await fulfillCooRequests(coo, [], { delegate, requestConfirmation }), "");
});
