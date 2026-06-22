import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-processed-msgs-test.json");
process.env.PROCESSED_MSGS_PATH = TMP;
process.env.PROCESSED_MSGS_CAP = "3";
const { isProcessed, markProcessed, unmarkProcessed } = await import("../src/processed-messages.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("a message is not processed until marked; mark persists (survives restart)", async () => {
  assert.equal(await isProcessed("msg-1"), false);
  await markProcessed("msg-1");
  assert.equal(await isProcessed("msg-1"), true); // a fresh read (== a post-restart read) still sees it
});

test("unmark lets a failed message be retried", async () => {
  await markProcessed("msg-2");
  await unmarkProcessed("msg-2");
  assert.equal(await isProcessed("msg-2"), false);
});

test("the store is a bounded FIFO (oldest ids drop, recent ones kept)", async () => {
  await markProcessed("a");
  await markProcessed("b");
  await markProcessed("c");
  await markProcessed("d"); // cap is 3 -> "a" drops
  assert.equal(await isProcessed("a"), false);
  assert.equal(await isProcessed("d"), true);
  assert.equal(await isProcessed("b"), true);
});

test("blank/undefined ids are ignored", async () => {
  assert.equal(await isProcessed(""), false);
  await markProcessed(undefined); // no throw, no write
  assert.equal(await isProcessed(undefined), false);
});
