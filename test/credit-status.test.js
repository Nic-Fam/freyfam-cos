import { test } from "node:test";
import assert from "node:assert";

// Set a key BEFORE importing so anthropicCreditStatus actually probes (it no-ops
// without a key). fetchImpl is injected so no real API call is made.
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
const { anthropicCreditStatus } = await import("../src/cost.js");

const fakeFetch = (status, bodyText) => async () => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => bodyText,
});

test("ok response => balance is fine", async () => {
  const r = await anthropicCreditStatus({ fetchImpl: fakeFetch(200, "{}") });
  assert.deepEqual(r, { ok: true });
});

test("400 'credit balance is too low' => flagged", async () => {
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } });
  const r = await anthropicCreditStatus({ fetchImpl: fakeFetch(400, body) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /credit balance/i);
});

test("402 payment required => flagged even without matching text", async () => {
  assert.equal((await anthropicCreditStatus({ fetchImpl: fakeFetch(402, "Payment Required") })).ok, false);
});

test("a 500 / rate-limit is NOT treated as a balance problem", async () => {
  assert.equal((await anthropicCreditStatus({ fetchImpl: fakeFetch(500, "internal error") })).ok, true);
  assert.equal((await anthropicCreditStatus({ fetchImpl: fakeFetch(429, "rate limit") })).ok, true);
});

test("a network error does not false-alarm", async () => {
  const throwing = async () => { throw new Error("ECONNRESET"); };
  assert.deepEqual(await anthropicCreditStatus({ fetchImpl: throwing }), { ok: true });
});
