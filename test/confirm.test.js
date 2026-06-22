import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-pending-approvals-test.json");
process.env.PENDING_APPROVALS_PATH = TMP;
const { requestConfirmation, resolveByCode, tryResolveConfirmation, registerActionHandler } = await import("../src/confirm.js");

// A test executor: records the params it ran with, keyed by `kind`.
let ran;
registerActionHandler("test", async (params) => { ran.push(params); return `did: ${params.what}`; });
registerActionHandler("boom", async () => { throw new Error("kaboom"); });

beforeEach(async () => { ran = []; await rm(TMP, { force: true }); });
after(() => rm(TMP, { force: true }));

test("requestConfirmation stages without executing and returns a code + instruction", async () => {
  const { code, instruction } = await requestConfirmation("do a thing", "test", { what: "x" });
  assert.match(code, /^[0-9A-F]{4}$/);
  assert.match(instruction, new RegExp(`YES ${code}`));
  assert.deepEqual(ran, [], "must not run until approved");
});

test("YES runs the staged action with its params and returns the result", async () => {
  const { code } = await requestConfirmation("create event X", "test", { what: "event" });
  const res = await tryResolveConfirmation(`YES ${code}`);
  assert.equal(res.handled, true);
  assert.equal(res.message, "did: event");
  assert.deepEqual(ran, [{ what: "event" }]);
});

test("NO cancels without running", async () => {
  const { code } = await requestConfirmation("send mail", "test", { what: "y" });
  const res = await tryResolveConfirmation(`NO ${code}`);
  assert.match(res.message, /Cancelled/);
  assert.deepEqual(ran, []);
});

test("staged approvals PERSIST across a fresh module load (restart-safe)", async () => {
  const { code } = await requestConfirmation("survive a restart", "test", { what: "persisted" });
  // Re-import with a cache-busting query to simulate a brand-new process reading the file.
  const fresh = await import(`../src/confirm.js?reload=${code}`);
  fresh.registerActionHandler("test", async (params) => { ran.push(params); return `did: ${params.what}`; });
  const res = await fresh.tryResolveConfirmation(`YES ${code}`);
  assert.equal(res.message, "did: persisted");
  assert.deepEqual(ran, [{ what: "persisted" }]);
});

test("a code resolves only once", async () => {
  const { code } = await requestConfirmation("once", "test", { what: "z" });
  assert.equal((await resolveByCode(code, true)).found, true);
  assert.equal((await resolveByCode(code, true)).found, false);
});

test("unknown/expired code is handled, non-approval text is not", async () => {
  assert.match((await tryResolveConfirmation("YES ZZZZ")).message, /unknown or expired/i);
  assert.equal((await tryResolveConfirmation("what's on the calendar?")).handled, false);
});

test("a failing action surfaces as an error message, not a throw", async () => {
  const { code } = await requestConfirmation("flaky", "boom", {});
  const res = await tryResolveConfirmation(`yes ${code}`);
  assert.match(res.message, /failed: kaboom/);
});

test("requestConfirmation rejects an unregistered kind", async () => {
  await assert.rejects(() => requestConfirmation("x", "nope", {}), /no action handler/);
});
