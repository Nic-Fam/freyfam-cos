import { test } from "node:test";
import assert from "node:assert";
import {
  isPrimeChannel,
  buildCancelPlaybook,
  validateCancelResult,
  SUBSCRIPTIONS_URL,
} from "../src/amazon-streaming-cancel.js";

test("isPrimeChannel refuses Prime, allows channel add-ons", () => {
  assert.equal(isPrimeChannel("Amazon Prime"), true);
  assert.equal(isPrimeChannel("Prime Video"), true); // part of Prime -> refuse
  assert.equal(isPrimeChannel("AMC+"), false);
  assert.equal(isPrimeChannel("Paramount+"), false);
  assert.equal(isPrimeChannel(""), false);
});

test("buildCancelPlaybook carries the channel, account guard, Prime refusal, and JSON contract", () => {
  const p = buildCancelPlaybook({ channel: "AMC+", amount: "$8.99", renewalDate: "Jul 20" });
  assert.match(p, /TARGET CHANNEL: AMC\+/);
  assert.match(p, /ACCOUNT VERIFICATION/);
  assert.match(p, new RegExp(SUBSCRIPTIONS_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(p, /prime_refused/);
  assert.match(p, /Do NOT request a refund/i);
  assert.match(p, /"ok":true/);
});

test("validateCancelResult refuses Prime even on ok:true", () => {
  const r = validateCancelResult({ ok: true, channel: "Amazon Prime", accountVerifiedAs: "Hello, Nic" });
  assert.deepEqual(r, { ok: false, reason: "prime_refused" });
});

test("validateCancelResult refuses the wrong / unknown account on ok:true", () => {
  assert.equal(validateCancelResult({ ok: true, channel: "AMC+", accountVerifiedAs: "Hello, Assistant" }).reason, "wrong_amazon_account");
  assert.equal(validateCancelResult({ ok: true, channel: "AMC+", accountVerifiedAs: "Hello, Bob" }).reason, "unknown_amazon_account");
});

test("validateCancelResult passes a clean, verified success", () => {
  const r = validateCancelResult({ ok: true, channel: "AMC+", accountVerifiedAs: "Hello, Nic" });
  assert.deepEqual(r, { ok: true, channel: "AMC+" });
});

test("validateCancelResult surfaces a reported failure reason", () => {
  assert.equal(validateCancelResult({ ok: false, reason: "channel_not_found" }).reason, "channel_not_found");
  assert.equal(validateCancelResult(null).reason, "no_result");
});
