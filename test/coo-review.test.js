import test from "node:test";
import assert from "node:assert";
import { buildReviewPrompt, shouldRunReview, runCooReview } from "../src/coo-review.js";
import { companyAgent } from "../src/companies.js";

const coo = companyAgent("sasshey-coo"); // { type:"coo", key, company:"Sasshey", companyKey:"sasshey", allowedSpecialists:[...] }

// --- prompt + scheduling ----------------------------------------------------

test("buildReviewPrompt names the company and asks for a lean status", () => {
  const p = buildReviewPrompt(coo);
  assert.match(p, /Sasshey/);
  assert.match(p, /request_specialist/);
  assert.match(p, /only.*warranted/i);
});

test("shouldRunReview fires once inside the window, not before, not twice", () => {
  const cfg = { hour: 8, windowHours: 3, tz: "America/Los_Angeles" };
  const inWindow = new Date("2026-06-15T16:00:00Z"); // 9am PT
  const before = new Date("2026-06-15T12:00:00Z"); // 5am PT
  const r1 = shouldRunReview(inWindow, null, cfg);
  assert.equal(r1.run, true);
  assert.equal(shouldRunReview(before, null, cfg).run, false, "before the window");
  assert.equal(shouldRunReview(inWindow, r1.date, cfg).run, false, "already ran today");
});

// --- runCooReview -----------------------------------------------------------

function deps(overrides = {}) {
  const calls = { delegated: [], staged: [], notes: [] };
  return {
    calls,
    delegate: async ({ agent, task }) => { calls.delegated.push({ agent, task }); return { text: "Status: steady.", requests: [] }; },
    requestConfirmation: async (a, kind, params) => { calls.staged.push({ kind, params }); return { code: "AB12", instruction: "Reply YES AB12." }; },
    budgetState: async () => ({ over: false }),
    notify: async (m) => calls.notes.push(m),
    ...overrides,
  };
}

test("runCooReview delegates the review to the COO and reports back", async () => {
  const d = deps();
  const r = await runCooReview(coo, { delegate: d.delegate, requestConfirmation: d.requestConfirmation, budgetState: d.budgetState, notify: d.notify, notifyText: false });
  assert.equal(r.ran, true);
  assert.equal(r.company, "sasshey");
  assert.equal(d.calls.delegated.length, 1);
  assert.equal(d.calls.delegated[0].agent, "sasshey-coo");
  assert.match(d.calls.delegated[0].task, /scheduled review of Sasshey/);
  assert.equal(d.calls.notes.length, 0, "quiet by default (notifyText false)");
});

test("runCooReview fulfills the COO's emitted requests behind the gate", async () => {
  const d = deps({
    // COO returns a heavy-lift request this time.
    delegate: async ({ agent }) => {
      // first call = the review (COO); a fulfillment specialist call would be a 2nd
      if (agent === "sasshey-coo") return { text: "Need a build.", requests: [{ type: "heavy_lift", brief: "MVP importer", why: "launch" }] };
      return { text: `did:${agent}`, requests: [] };
    },
  });
  const r = await runCooReview(coo, { delegate: d.delegate, requestConfirmation: d.requestConfirmation, budgetState: d.budgetState, notify: d.notify, notifyText: true });
  assert.equal(r.requestCount, 1);
  assert.deepEqual(d.calls.staged.map((s) => s.kind), ["heavy_lift"], "heavy lift routed through the gate");
  assert.equal(d.calls.notes.length, 1, "notifyText true -> owner gets the review summary");
  assert.match(d.calls.notes[0], /COO review \(Sasshey\)/);
});

test("runCooReview skips an over-budget company without spending", async () => {
  const d = deps({ budgetState: async () => ({ over: true }) });
  const r = await runCooReview(coo, { delegate: d.delegate, requestConfirmation: d.requestConfirmation, budgetState: d.budgetState, notify: d.notify });
  assert.equal(r.ran, false);
  assert.equal(r.skipped, "over-budget");
  assert.equal(d.calls.delegated.length, 0, "no delegate call when over budget");
});
