import { test } from "node:test";
import assert from "node:assert";
import { transportFor, wrapDelegateWithMirror } from "../src/orchestrator.js";

test("transportFor gives reply+mirror per channel; mirror is a safe no-op", () => {
  for (const channel of ["sms", "email", "whatever"]) {
    const t = transportFor({ channel, from: "+1", replyTo: "+1" });
    assert.equal(typeof t.reply, "function", `${channel} has reply`);
    assert.equal(typeof t.mirror, "function", `${channel} has mirror`);
    assert.doesNotThrow(() => t.mirror({ phase: "start" }), `${channel} mirror is callable`);
  }
});

test("wrapDelegateWithMirror echoes start + result and returns the result", async () => {
  const events = [];
  const delegateFn = async ({ agent, task, images }) => {
    assert.equal(images, "IMG", "images forwarded to the delegate call");
    return `did ${agent}: ${task}`;
  };
  const wrapped = wrapDelegateWithMirror(delegateFn, {
    onDelegate: (e) => events.push(e),
    images: "IMG",
  });

  const result = await wrapped({ agent: "finance", task: "reconcile" });

  assert.equal(result, "did finance: reconcile");
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => e.phase),
    ["start", "result"]
  );
  assert.equal(events[0].agent, "finance");
  assert.equal(events[1].result, "did finance: reconcile");
});

test("wrapDelegateWithMirror works with no onDelegate (heartbeat path)", async () => {
  const wrapped = wrapDelegateWithMirror(async () => "ok", {});
  assert.equal(await wrapped({ agent: "dev", task: "x" }), "ok");
});
