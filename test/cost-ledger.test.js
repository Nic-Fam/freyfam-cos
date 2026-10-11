import test from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { priceFor, costOfUsage, cycleKey, recordUsage, budgetState, cycleSummary } from "../src/cost-ledger.js";
import { MODELS } from "../src/config.js";

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
  assert.deepEqual(priceFor("mystery-model"), priceFor(MODELS.standard));
});

test("current-generation prices and TTL-aware cache writes", () => {
  const h = priceFor("claude-haiku-5-5");
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(h.input, 0.1) && near(h.output, 0.5) && near(h.cacheWrite, 0.125) && near(h.cacheWrite1h, 0.2) && near(h.cacheRead, 0.01), JSON.stringify(h));
  assert.equal(priceFor("claude-opus-5-5").cacheRead, 0.2, "Opus 5.5 cache reads are 0.05x, set explicitly");
  assert.equal(priceFor("claude-opus-4-8").input, 5, "Opus 4.8 is $5/$25, not $15/$75");
  // 1M tokens written to the 1h prefix on Sonnet 5.5 = $4 (2x); on the 5m breakpoint = $2.50 (1.25x).
  const usd = costOfUsage("claude-sonnet-5-5", { cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000, ephemeral_5m_input_tokens: 1_000_000 } });
  assert.ok(Math.abs(usd - 6.5) < 1e-9, `got ${usd}`);
  // Without the breakdown, the aggregate is priced at the 5m rate.
  const flat = costOfUsage("claude-sonnet-5-5", { cache_creation_input_tokens: 1_000_000 });
  assert.ok(Math.abs(flat - 2.5) < 1e-9, `got ${flat}`);
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
