import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// queue.js builds its QueueClients at import time, so give it a syntactically
// valid (never contacted) connection string, and isolate the dedup store.
process.env.AZURE_STORAGE_CONNECTION_STRING ||=
  "DefaultEndpointsProtocol=https;AccountName=testacct;AccountKey=dGVzdA==;EndpointSuffix=core.windows.net";
const PROC = join(os.tmpdir(), "cos-queue-test-processed.json");
process.env.PROCESSED_MSGS_PATH = PROC;

const { processMessage, withLease } = await import("../src/queue.js");
const { isProcessed } = await import("../src/processed-messages.js");

const clean = () => rm(PROC, { force: true });
beforeEach(clean);
after(clean);

function fakeQueue({ deleteFails = false } = {}) {
  const q = { deleted: [], updated: [] };
  q.deleteMessage = async (id, receipt) => {
    if (deleteFails) throw new Error("PopReceiptMismatch");
    q.deleted.push({ id, receipt });
  };
  q.updateMessage = async (id, receipt, _body, vis) => {
    q.updated.push({ id, receipt, vis });
    return { popReceipt: `${receipt}+1` };
  };
  return q;
}
const msg = (over = {}) => ({
  messageId: "m1",
  popReceipt: "r1",
  dequeueCount: 1,
  messageText: Buffer.from(JSON.stringify({ from: "x", body: "hi", channel: "voice" })).toString("base64"),
  ...over,
});
const noLease = (q, m, work) => work();

test("a handled message is acked once and stays marked processed", async () => {
  const q = fakeQueue();
  let calls = 0;
  const r = await processMessage(msg(), { q, handler: async () => void calls++, lease: noLease });
  assert.equal(r, "handled");
  assert.equal(calls, 1);
  assert.equal(q.deleted.length, 1);
  assert.equal(await isProcessed("m1"), true);
});

test("a redelivered message that was already handled is deleted without re-running the handler", async () => {
  const q = fakeQueue();
  let calls = 0;
  await processMessage(msg(), { q, handler: async () => void calls++, lease: noLease });
  const r = await processMessage(msg({ popReceipt: "r2", dequeueCount: 2 }), { q, handler: async () => void calls++, lease: noLease });
  assert.equal(r, "duplicate");
  assert.equal(calls, 1, "side effects must not run twice");
  assert.equal(q.deleted.length, 2);
});

test("ack failure AFTER successful handling keeps the dedup mark (the B2 duplicate-run bug)", async () => {
  // Old behaviour: the stale pop receipt made deleteMessage throw, the catch
  // unmarked the message, and the visibility-timeout redelivery re-ran the whole
  // turn (duplicate replies + duplicate staged approvals).
  const q = fakeQueue({ deleteFails: true });
  let calls = 0;
  const r = await processMessage(msg(), { q, handler: async () => void calls++, lease: noLease });
  assert.equal(r, "handled-unacked");
  assert.equal(calls, 1);
  assert.equal(await isProcessed("m1"), true, "must stay marked so the redelivery is absorbed");
});

test("a handler failure unmarks the message so the redelivery retries it", async () => {
  const q = fakeQueue();
  const r = await processMessage(msg(), { q, handler: async () => { throw new Error("transient"); }, lease: noLease });
  assert.equal(r, "retry");
  assert.equal(await isProcessed("m1"), false);
  assert.equal(q.deleted.length, 0, "left on the queue");
});

test("withLease renews visibility on a timer and adopts the new pop receipt", async () => {
  const q = fakeQueue();
  const m = msg();
  let tickFn;
  const setTimer = (fn) => { tickFn = fn; return "t"; };
  let cleared = null;
  const clearTimer = (t) => { cleared = t; };
  const out = await withLease(q, m, async () => {
    await tickFn(); // simulate one renewal while work is in flight
    await tickFn();
    return "done";
  }, { visibilityS: 600, everyMs: 1, setTimer, clearTimer });
  assert.equal(out, "done");
  assert.equal(q.updated.length, 2);
  assert.equal(q.updated[0].vis, 600);
  assert.equal(q.updated[1].receipt, "r1+1", "second renewal uses the receipt the first one returned");
  assert.equal(m.popReceipt, "r1+1+1", "the message carries the latest receipt for the final delete");
  assert.equal(cleared, "t", "timer cleared when work ends");
});

test("withLease survives a failed renewal and still clears the timer on throw", async () => {
  const q = fakeQueue();
  q.updateMessage = async () => { throw new Error("nope"); };
  let tickFn;
  let cleared = false;
  await assert.rejects(
    withLease(q, msg(), async () => { await tickFn(); throw new Error("work failed"); }, { setTimer: (fn) => { tickFn = fn; return 1; }, clearTimer: () => { cleared = true; } }),
    /work failed/
  );
  assert.equal(cleared, true);
});
