import { test } from "node:test";
import assert from "node:assert/strict";
import { isThinkingByDefault, applyThinkingDefaults } from "../src/claude.js";

test("5.x models are detected as thinking-by-default; 4.x are not", () => {
  for (const m of ["claude-sonnet-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-20260901"])
    assert.equal(isThinkingByDefault(m), true, m);
  for (const m of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-8", "", undefined])
    assert.equal(isThinkingByDefault(m), false, String(m));
});

test("applyThinkingDefaults raises max_tokens floor and sets effort for 5.x only", () => {
  const a = applyThinkingDefaults({ model: "claude-sonnet-5-5", max_tokens: 1024 }, {});
  assert.equal(a.max_tokens, 8192);
  assert.deepEqual(a.output_config, { effort: "medium" });
  const b = applyThinkingDefaults({ model: "claude-opus-5-5", max_tokens: 20000 }, { MODEL_EFFORT: "high", MODEL_MIN_MAX_TOKENS: "4096" });
  assert.equal(b.max_tokens, 20000, "never lowers a larger budget");
  assert.equal(b.output_config.effort, "high");
  const c = applyThinkingDefaults({ model: "claude-haiku-4-5-20251001", max_tokens: 200 }, {});
  assert.equal(c.max_tokens, 200);
  assert.equal(c.output_config, undefined);
});
