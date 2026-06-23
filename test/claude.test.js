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
