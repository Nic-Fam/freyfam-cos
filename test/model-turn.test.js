import test from "node:test";
import assert from "node:assert";
import { modelForTurn, modelForComplexity, MODELS } from "../src/config.js";

test("voice turns run on Haiku for normal complexity, but escalate for complex/high-stakes", () => {
  // non-voice is unchanged
  assert.equal(modelForTurn({ channel: "email", complexity: "standard" }), MODELS.standard);
  assert.equal(modelForTurn({ channel: "slack", complexity: "complex" }), MODELS.heavy);
  // voice: standard/trivial -> Haiku (fast)
  assert.equal(modelForTurn({ channel: "voice", complexity: "standard" }), MODELS.triage);
  assert.equal(modelForTurn({ channel: "voice", complexity: "trivial" }), MODELS.triage);
  // voice: complex keeps Opus; high-stakes stays OFF the fast path -> Sonnet (not Haiku)
  assert.equal(modelForTurn({ channel: "voice", complexity: "complex" }), MODELS.heavy);
  assert.equal(modelForTurn({ channel: "voice", complexity: "standard", high_stakes: true }), MODELS.standard);
});

test("high-stakes sets a Sonnet floor, not Opus — Opus is reserved for complex work", () => {
  // high-stakes but not complex -> Sonnet (the confirmation gate is the protection)
  assert.equal(modelForComplexity("standard", true), MODELS.standard);
  assert.equal(modelForComplexity("trivial", true), MODELS.standard, "even a trivial outbound gets Sonnet, not Haiku");
  // complex still escalates to Opus, high-stakes or not
  assert.equal(modelForComplexity("complex", true), MODELS.heavy);
  assert.equal(modelForComplexity("complex", false), MODELS.heavy);
  // non-high-stakes routing is unchanged
  assert.equal(modelForComplexity("trivial", false), MODELS.triage);
  assert.equal(modelForComplexity("standard", false), MODELS.standard);
});

test("COS_VOICE_FAST=false disables the voice fast-path", () => {
  const prev = process.env.COS_VOICE_FAST;
  process.env.COS_VOICE_FAST = "false";
  try {
    assert.equal(modelForTurn({ channel: "voice", complexity: "standard" }), MODELS.standard);
  } finally {
    if (prev === undefined) delete process.env.COS_VOICE_FAST; else process.env.COS_VOICE_FAST = prev;
  }
});

test("modelForTurn falls back to modelForComplexity for a missing channel", () => {
  assert.equal(modelForTurn({ complexity: "standard" }), modelForComplexity("standard"));
});
