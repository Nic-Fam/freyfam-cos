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
  // voice: complex or high-stakes keep their escalated model (safety/quality)
  assert.equal(modelForTurn({ channel: "voice", complexity: "complex" }), MODELS.heavy);
  assert.equal(modelForTurn({ channel: "voice", complexity: "standard", high_stakes: true }), MODELS.heavy);
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
