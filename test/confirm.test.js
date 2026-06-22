import { test } from "node:test";
import assert from "node:assert";
import { requestConfirmation, resolveByCode, tryResolveConfirmation } from "../src/confirm.js";

// The deferred model: requestConfirmation stages an action and returns a code
// WITHOUT blocking; the action runs only when the code is approved. This is what
// breaks the serial-consumer deadlock (the turn no longer waits for the reply).

test("requestConfirmation returns immediately with a code + instruction and does not execute yet", () => {
  let ran = false;
  const { code, instruction } = requestConfirmation("do a thing", async () => { ran = true; return "did it"; });
  assert.match(code, /^[0-9A-F]{4}$/);
  assert.match(instruction, new RegExp(`YES ${code}`));
  assert.equal(ran, false, "action must not run until approved");
});

test("YES <code> runs the staged action and returns its result", async () => {
  let ran = 0;
  const { code } = requestConfirmation("create event X", async () => { ran++; return "Event created: X"; });
  const res = await tryResolveConfirmation(`YES ${code}`);
  assert.equal(res.handled, true);
  assert.equal(res.message, "Event created: X");
  assert.equal(ran, 1);
});

test("NO <code> cancels without running the action", async () => {
  let ran = false;
  const { code } = requestConfirmation("send email", async () => { ran = true; return "sent"; });
  const res = await tryResolveConfirmation(`NO ${code}`);
  assert.equal(res.handled, true);
  assert.match(res.message, /Cancelled/);
  assert.equal(ran, false);
});

test("a code can only be resolved once", async () => {
  const { code } = requestConfirmation("once only", async () => "ok");
  assert.equal((await resolveByCode(code, true)).found, true);
  assert.equal((await resolveByCode(code, true)).found, false); // already consumed
});

test("an unknown/expired code is handled (not routed as a normal message)", async () => {
  const res = await tryResolveConfirmation("YES ZZZZ");
  assert.equal(res.handled, true);
  assert.match(res.message, /unknown or expired/i);
});

test("a non-approval message is not handled (normal routing continues)", async () => {
  assert.equal((await tryResolveConfirmation("what's on the calendar?")).handled, false);
  assert.equal((await tryResolveConfirmation("")).handled, false);
});

test("a failing action surfaces as an error message, not a throw", async () => {
  const { code } = requestConfirmation("flaky", async () => { throw new Error("boom"); });
  const res = await tryResolveConfirmation(`yes ${code}`);
  assert.equal(res.handled, true);
  assert.match(res.message, /failed: boom/);
});
