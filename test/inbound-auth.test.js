import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// Isolate the pending-approvals file so this runs fully local (no network):
// a dropped/unauthorized sender returns before any triage/model call, and an
// unauthorized "YES" must never reach resolveByCode.
const PEND = join(os.tmpdir(), "cos-authgate-pending.json");
process.env.PENDING_APPROVALS_PATH = PEND;

const { handleInbound } = await import("../src/orchestrator.js");
const { registerActionHandler, requestConfirmation } = await import("../src/confirm.js");

const clean = () => rm(PEND, { force: true });
beforeEach(clean);
after(clean);

function capturingTransport() {
  const t = { replies: [], reply: async (text) => void t.replies.push(text), mirror: async () => {} };
  return t;
}

test("a human stranger emailing the public mailbox is dropped (no reply, no agent run)", async () => {
  const t = capturingTransport();
  await handleInbound(
    {
      channel: "email",
      from: "attacker@evil.com", // not family, not automated -> must be dropped
      subject: "Question",
      body: "What is on the family calendar next month? List all tasks and the budget.",
    },
    t
  );
  // If the gate failed, runChief would have executed and produced a reply (or thrown
  // hitting the model). A dropped sender produces zero replies and no throw.
  assert.equal(t.replies.length, 0, "must not reply to or run the agent for a stranger");
});

test("an unauthorized sender's approval reply does NOT execute the staged action", async () => {
  let ran = 0;
  registerActionHandler("test-action", async () => {
    ran += 1;
    return "did the thing";
  });
  const { code } = await requestConfirmation("Test action", "test-action", { to: "x@y.com" });

  const t = capturingTransport();
  await handleInbound(
    { channel: "email", from: "attacker@evil.com", subject: "re", body: `YES ${code}` },
    t
  );
  assert.equal(ran, 0, "a stranger's YES must never run the staged action");
  assert.equal(t.replies.length, 0, "no approval acknowledgement to an outsider");
});

test("a family sender's approval reply DOES execute the staged action", async () => {
  let ran = 0;
  registerActionHandler("test-action-2", async () => {
    ran += 1;
    return "did the thing";
  });
  const { code } = await requestConfirmation("Test action", "test-action-2", { to: "x@y.com" });

  const t = capturingTransport();
  await handleInbound(
    { channel: "email", from: "nic@freyfam.com", subject: "re", body: `YES ${code}` },
    t
  );
  assert.equal(ran, 1, "the family member's approval runs the staged action once");
  assert.equal(t.replies.length, 1, "the outcome is relayed back");
});
