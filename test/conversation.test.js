import { test, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-convo-test.json");
process.env.CONVO_PATH = TMP;
process.env.CONVO_MAX_MESSAGES = "4";
process.env.CONVO_IDLE_TTL_MS = "1000";
const { conversationKey, getHistory, appendTurn } = await import("../src/conversation.js");

after(() => rm(TMP, { force: true }));

test("conversationKey is channel + lowercased sender", () => {
  assert.equal(conversationKey({ channel: "sms", from: "+1555" }), "sms:+1555");
  assert.equal(conversationKey({ channel: "email", from: "Nic@Freyfam.com" }), "email:nic@freyfam.com");
});

test("appendTurn then getHistory returns the exchange as messages", async () => {
  await rm(TMP, { force: true });
  const k = "sms:+1";
  const t = 10_000;
  await appendTurn(k, "schedule a haircut", "Whose haircut, and where?", t);
  const h = await getHistory(k, t + 1);
  assert.deepEqual(h, [
    { role: "user", content: "schedule a haircut", ts: t },
    { role: "assistant", content: "Whose haircut, and where?", ts: t },
  ]);
  assert.equal(h[0].ts, t, "each turn is stamped with when it was said");
});

test("history accumulates and trims to the window (CONVO_MAX_MESSAGES=4)", async () => {
  await rm(TMP, { force: true });
  const k = "sms:+2";
  await appendTurn(k, "one", "r1", 1000);
  await appendTurn(k, "two", "r2", 1100);
  await appendTurn(k, "three", "r3", 1200); // 6 messages -> trimmed to last 4
  const h = await getHistory(k, 1250);
  assert.equal(h.length, 4);
  assert.deepEqual(h.map((m) => m.content), ["two", "r2", "three", "r3"]);
});

test("a thread older than the idle TTL is treated as fresh (no stale bleed)", async () => {
  await rm(TMP, { force: true });
  const k = "sms:+3";
  await appendTurn(k, "yesterday", "old reply", 1000);
  assert.deepEqual(await getHistory(k, 1000 + 2000), []); // 2s > 1s TTL
  // and a new turn starts a clean thread
  await appendTurn(k, "today", "new reply", 1000 + 3000);
  assert.deepEqual((await getHistory(k, 1000 + 3001)).map((m) => m.content), ["today", "new reply"]);
});

test("a blank assistant reply is not recorded", async () => {
  await rm(TMP, { force: true });
  const k = "sms:+4";
  await appendTurn(k, "hi", "   ", 1000);
  assert.deepEqual(await getHistory(k, 1001), []);
});
