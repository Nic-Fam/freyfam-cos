import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const STORE = join(os.tmpdir(), "cos-cs-store.json");
const SEEN = join(os.tmpdir(), "cos-cs-seen.json");
process.env.CREDIT_STATEMENT_PATH = STORE;
process.env.CREDIT_STATEMENT_SEEN_PATH = SEEN;
const cs = await import("../src/credit-statement.js");

const clean = async () => { await rm(STORE, { force: true }); await rm(SEEN, { force: true }); };
beforeEach(clean);
after(clean);

test("isCreditStatement: statement notices yes, single-charge alerts no", () => {
  assert.equal(cs.isCreditStatement({ from: "no.reply.alerts@chase.com", subject: "Your statement is ready", body: "New balance $15,963.29" }), true);
  assert.equal(cs.isCreditStatement({ from: "no.reply.alerts@chase.com", subject: "You made a $73.00 transaction with SEES" }), false);
  assert.equal(cs.isCreditStatement({ from: "friend@example.com", subject: "your statement is ready" }), false); // not an issuer
});

test("extractStatement parses balance via the model (injected)", async () => {
  const fakeComplete = async () => ({ content: [{ type: "text", text: '{"card":"1234","statementBalance":15963.29,"minimumDue":410,"dueDate":"2026-07-06"}' }] });
  const ex = await cs.extractStatement({ from: "chase.com", subject: "Statement ready", body: "..." }, { complete: fakeComplete });
  assert.equal(ex.statementBalance, 15963.29);
  assert.equal(ex.card, "1234");
  assert.equal(ex.dueDate, "2026-07-06");
});

test("setStatement upserts per card; currentStatementPayment sums fresh ones", async () => {
  await cs.setStatement({ card: "1234", statementBalance: 15963.29, dueDate: "2026-07-06" });
  await cs.setStatement({ card: "1234", statementBalance: 16000.00 }); // newer for same card -> replaces
  await cs.setStatement({ card: "9999", statementBalance: 250.00 });
  const pay = await cs.currentStatementPayment({ now: new Date("2026-06-28T12:00:00Z") });
  assert.equal(pay.cards, 2);
  assert.equal(pay.total, 16250.00); // 16000 + 250
});

test("currentStatementPayment ignores stale statements", async () => {
  await cs.setStatement({ card: "1234", statementBalance: 15963.29 });
  // make it look old by rewriting capturedAt far in the past
  const { createCollection } = await import("../src/stores/collection.js");
  const col = createCollection({ file: STORE, partition: "creditstatement" });
  const items = await col.list();
  await col.remove(items[0].id);
  await col.add({ ...items[0], capturedAt: "2025-01-01T00:00:00Z" });
  const pay = await cs.currentStatementPayment({ now: new Date("2026-06-28T12:00:00Z"), freshDays: 45 });
  assert.equal(pay, null);
});

test("scanInboxForStatements captures once and dedups", async () => {
  const fakeComplete = async () => ({ content: [{ type: "text", text: '{"card":"1234","statementBalance":15963.29,"dueDate":"2026-07-06"}' }] });
  const mails = [
    { from: "no.reply.alerts@chase.com", subject: "Your statement is ready", body: "New balance $15,963.29", receivedAt: "2026-06-20T00:00:00Z" },
    { from: "friend@x.com", subject: "hi", body: "hello", receivedAt: "2026-06-20T01:00:00Z" },
  ];
  const r1 = await cs.scanInboxForStatements(mails, { complete: fakeComplete });
  assert.equal(r1.captured, 1);
  const r2 = await cs.scanInboxForStatements(mails, { complete: fakeComplete }); // same email next tick
  assert.equal(r2.captured, 0, "already seen");
  const pay = await cs.currentStatementPayment({ now: new Date("2026-06-25T00:00:00Z") });
  assert.equal(pay.total, 15963.29);
});
