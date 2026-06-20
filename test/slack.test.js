import { test } from "node:test";
import assert from "node:assert";
import { agentForChannel, mirrorText, approvalBlocks } from "../src/channels/slack.js";

test("agentForChannel forces a specialist for per-agent channels, null otherwise", () => {
  assert.equal(agentForChannel("finance"), "finance");
  assert.equal(agentForChannel("#security"), "security");
  assert.equal(agentForChannel("CHEF"), "chef");
  assert.equal(agentForChannel("cos"), null, "#cos -> chief (null = not forced)");
  assert.equal(agentForChannel("random"), null);
  assert.equal(agentForChannel(null), null);
});

test("mirrorText renders the #command delegation feed", () => {
  const start = mirrorText({ phase: "start", from: "Lloyd", agent: "finance", task: "reconcile October" });
  assert.match(start, /Lloyd → finance/);
  assert.match(start, /reconcile October/);
  const result = mirrorText({ phase: "result", agent: "finance", result: "done, all matched" });
  assert.match(result, /finance/);
  assert.match(result, /done, all matched/);
  assert.equal(mirrorText({ phase: "other" }), "");
  assert.equal(mirrorText(null), "");
});

test("approvalBlocks carries the code in the Approve/Deny button values", () => {
  const blocks = approvalBlocks("9Z3Q", "Email to nic@freyfam.com");
  const actions = blocks.find((b) => b.type === "actions");
  assert.ok(actions, "has an actions block");
  const ids = actions.elements.map((e) => e.action_id);
  assert.deepEqual(ids, ["cos_approve", "cos_deny"]);
  for (const el of actions.elements) assert.equal(el.value, "9Z3Q", "button carries the code");
  assert.match(blocks[0].text.text, /9Z3Q/);
});
