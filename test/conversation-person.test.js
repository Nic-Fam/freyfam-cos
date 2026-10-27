import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), `cos-convo-person-${process.pid}.json`);
process.env.CONVO_PATH = TMP;
process.env.CONVO_MAX_MESSAGES = "4";
process.env.FAMILY_HANDLES_JSON = JSON.stringify({ nic: ["+1 (818) 555-0101", "U0NIC"], shelli: ["+18185550102"] });
const c = await import("../src/conversation.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("one thread per person across email, iMessage and Slack", () => {
  assert.equal(c.threadKeyFor({ channel: "email", from: "Nic@freyfam.com" }), "person:nic");
  assert.equal(c.threadKeyFor({ channel: "imessage", from: "+18185550101" }), "person:nic");
  assert.equal(c.threadKeyFor({ channel: "slack", from: "U0NIC" }), "person:nic");
  assert.equal(c.threadKeyFor({ channel: "sms", from: "8185550102" }), "person:shelli");
  assert.equal(c.threadKeyFor({ channel: "email", from: "stranger@example.com" }), "email:stranger@example.com");
});

test("Lloyd's own messages land in the thread, and older turns are kept condensed", async () => {
  const k = "person:nic";
  const t0 = Date.parse("2026-10-26T13:00:00Z");
  await c.recordOutbound(k, "Good morning! To do:\n1. Call the plumber", { kind: "morning digest", now: t0 });
  await c.appendTurn(k, "done 1", "Marked done: 1. Call the plumber.", t0 + 1000);
  await c.appendTurn(k, "what's for dinner", "Salmon.", t0 + 2000);
  const th = await c.getThread(k, t0 + 3000);
  assert.equal(th.messages.length, 4, "verbatim window");
  assert.equal(th.earlier.length, 1, "the digest scrolled into the condensed section");
  assert.match(th.earlier[0].text, /^\[Lloyd sent a morning digest\] Good morning!/);
});

test("a thread survives a day of quiet (72h window), unlike the old 45 minutes", async () => {
  const k = "person:shelli";
  const t0 = Date.parse("2026-10-26T15:00:00Z");
  await c.appendTurn(k, "remind me what Deborah said", "She said Thursday works.", t0);
  assert.equal((await c.getHistory(k, t0 + 26 * 3600e3)).length, 2);
});
