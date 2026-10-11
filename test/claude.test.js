import { test } from "node:test";
import assert from "node:assert";
import { withConvoCacheBreakpoint } from "../src/claude.js";

const EPHEMERAL = { type: "ephemeral" };

test("single fresh user message gets no breakpoint (nothing prior to cache)", () => {
  const msgs = [{ role: "user", content: "hello" }];
  assert.strictEqual(withConvoCacheBreakpoint(msgs), msgs); // returned as-is
});

test("multi-turn: breaks on the last block of the last message", () => {
  const msgs = [
    { role: "user", content: "do a thing" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "42" },
        { type: "tool_result", tool_use_id: "t2", content: "43" },
      ],
    },
  ];
  const out = withConvoCacheBreakpoint(msgs);
  const lastContent = out[out.length - 1].content;
  // only the final block carries the breakpoint
  assert.deepEqual(lastContent[1].cache_control, EPHEMERAL);
  assert.equal(lastContent[0].cache_control, undefined);
});

test("string content on a later turn is wrapped into a cached text block", () => {
  const msgs = [
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: "follow-up question" },
  ];
  const out = withConvoCacheBreakpoint(msgs);
  assert.deepEqual(out[1].content, [
    { type: "text", text: "follow-up question", cache_control: EPHEMERAL },
  ]);
});

test("does not mutate the caller's messages or blocks", () => {
  const block = { type: "text", text: "second" };
  const msgs = [
    { role: "user", content: "first" },
    { role: "assistant", content: [block] },
  ];
  const out = withConvoCacheBreakpoint(msgs);
  assert.notStrictEqual(out, msgs);
  assert.equal(block.cache_control, undefined); // original block untouched
  assert.deepEqual(out[1].content[0].cache_control, EPHEMERAL); // copy carries it
});

// --- request shape: effort, max_tokens, caching markers (policy 2026-10-11) ----
import { buildRequest, supportsEffort, effortFor, TRUNCATED_SENTINEL, MAX_TURNS_SENTINEL } from "../src/claude.js";

test("supportsEffort: current generation yes, Haiku 4.5 and older no", () => {
  for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-5", "claude-fable-5-1"]) {
    assert.equal(supportsEffort(m), true, m);
  }
  for (const m of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-1", "", undefined]) {
    assert.equal(supportsEffort(m), false, String(m));
  }
});

test("effortFor: Haiku low, Sonnet/Opus medium, explicit override wins, bad override ignored", () => {
  assert.equal(effortFor("claude-haiku-5-5"), "low");
  assert.equal(effortFor("claude-sonnet-5-5"), "medium");
  assert.equal(effortFor("claude-opus-5-5"), "medium");
  assert.equal(effortFor("claude-sonnet-5-5", "high"), "high");
  assert.equal(effortFor("claude-sonnet-5-5", "turbo"), "medium");
});

test("buildRequest: explicit effort only for models that accept it; tools+system cache markers; 8192-class caps allowed", () => {
  const tools = [{ name: "a", description: "", input_schema: { type: "object", properties: {} } }, { name: "b", description: "", input_schema: { type: "object", properties: {} } }];
  const r = buildRequest({ model: "claude-sonnet-5-5", system: [{ type: "text", text: "p" }], messages: [{ role: "user", content: "hi" }], tools, maxTokens: 8192 });
  assert.deepEqual(r.output_config, { effort: "medium" });
  assert.equal(r.max_tokens, 8192);
  assert.equal(r.tools[0].cache_control, undefined);
  assert.deepEqual(r.tools[1].cache_control, { type: "ephemeral", ttl: "1h" });
  assert.equal(r.thinking, undefined, "thinking is left to the model's adaptive default");
  const old = buildRequest({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] });
  assert.equal(old.output_config, undefined, "Haiku 4.5 400s on output_config.effort");
  assert.equal(old.max_tokens, 4096, "default cap leaves room for thinking");
});

test("sentinels are distinct strings callers can match on", () => {
  assert.notEqual(TRUNCATED_SENTINEL, MAX_TURNS_SENTINEL);
  assert.match(TRUNCATED_SENTINEL, /^\(stopped:/);
});
