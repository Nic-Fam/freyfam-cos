import test from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { priceFor, costOfUsage, cycleKey, recordUsage, budgetState, cycleSummary } from "../src/cost-ledger.js";

// Each test gets its own ledger file so accumulation is isolated.
let path;
test.beforeEach(() => {
  path = join(tmpdir(), `cost-ledger-${process.hrtime.bigint()}.json`);
  process.env.COST_LEDGER_PATH = path;
});
test.afterEach(async () => {
  await rm(path, { force: true });
  delete process.env.COST_LEDGER_PATH;
});

const now = new Date("2026-06-15T12:00:00Z");

// --- pricing math -----------------------------------------------------------

test("costOfUsage applies the price table per token bucket", () => {
  const p = priceFor("claude-sonnet-4-6");
  assert.equal(p.input, 3);
  assert.equal(p.output, 15);
  assert.equal(p.cacheWrite, 3 * 1.25); // default 1.25x input
  assert.equal(p.cacheRead, 3 * 0.1); // default 0.10x input
  // 1M input + 1M output = $3 + $15 = $18.
  const usd = costOfUsage("claude-sonnet-4-6", { input_tokens: 1_000_000, output_tokens: 1_000_000 });
  assert.ok(Math.abs(usd - 18) < 1e-9, `got ${usd}`);
});

test("an unknown model falls back to standard pricing", () => {
  assert.deepEqual(priceFor("mystery-model"), priceFor("claude-sonnet-4-6"));
});

test("cycleKey is a YYYY-MM month bucket", () => {
  assert.match(cycleKey(now), /^\d{4}-\d{2}$/);
});

// --- attribution + accumulation ---------------------------------------------

test("a non-company agent is not metered here (no-op)", async () => {
  const r = await recordUsage({ agent: "finance", model: "claude-sonnet-4-6", usage: { output_tokens: 1_000_000 } }, { now, notify: async () => {} });
  assert.equal(r, null);
});

test("a COO run accrues to its company; a company specialist rolls up to the same company", async () => {
  const notes = [];
  const notify = async (m) => notes.push(m);
  const a = await recordUsage({ agent: "sasshey-coo", model: "claude-sonnet-4-6", usage: { output_tokens: 1_000_000 } }, { now, notify }); // $15
  assert.equal(a.company, "sasshey");
  assert.equal(a.budgetUsd, 80);
  assert.equal(a.over, false);
  assert.ok(Math.abs(a.spentUsd - 15) < 1e-9);

  const b = await recordUsage({ agent: "sasshey-inventory", model: "claude-haiku-4-5", usage: { output_tokens: 1_000_000 } }, { now, notify }); // +$5
  assert.equal(b.company, "sasshey", "specialist rolls up to its company");
  assert.ok(Math.abs(b.spentUsd - 20) < 1e-9, "accumulated 15 + 5");

  const state = await budgetState("sasshey", { now });
  assert.ok(Math.abs(state.spentUsd - 20) < 1e-9);
  assert.ok(Math.abs(state.remaining - 60) < 1e-9);
  assert.equal(notes.length, 0, "no alert under budget");
});

test("crossing the budget alerts the owner exactly once per cycle", async () => {
  const notes = [];
  const notify = async (m) => notes.push(m);
  // $90 of Sonnet output in one shot blows past the $80 budget.
  const first = await recordUsage({ agent: "sasshey-coo", model: "claude-sonnet-4-6", usage: { output_tokens: 6_000_000 } }, { now, notify });
  assert.equal(first.over, true);
  assert.equal(first.crossed, true, "first crossing");
  assert.equal(notes.length, 1, "one alert");
  assert.match(notes[0], /over its .* budget/i);

  // Still over on the next run, but no second alert (already alerted this cycle).
  const second = await recordUsage({ agent: "sasshey-coo", model: "claude-haiku-4-5", usage: { output_tokens: 1_000_000 } }, { now, notify });
  assert.equal(second.over, true);
  assert.equal(second.crossed, false, "not re-alerted");
  assert.equal(notes.length, 1, "still just one alert");
});

test("cycleSummary lists each company's spend for the cycle", async () => {
  const notify = async () => {};
  await recordUsage({ agent: "dariviant-coo", model: "claude-sonnet-4-6", usage: { output_tokens: 1_000_000 } }, { now, notify });
  const summary = await cycleSummary({ now });
  const dari = summary.find((s) => s.company === "dariviant");
  assert.ok(dari, "dariviant present");
  assert.equal(dari.budgetUsd, 80);
  assert.equal(dari.over, false);
});
