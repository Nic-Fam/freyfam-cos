import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const INBOX = join(os.tmpdir(), "cos-finance-inbox-test.json");
const LOG = join(os.tmpdir(), "cos-finance-log-ingest-test.json");
process.env.FINANCE_INBOX_PATH = INBOX;
process.env.FINANCE_LOG_PATH = LOG;
const { isTransactionAlert, queueAlert, peekAlerts, drainAlerts, extractTransactions, buildDailyIngest } =
  await import("../src/finance-ingest.js");
const { listTransactions } = await import("../src/finance-log.js");

beforeEach(async () => { await rm(INBOX, { force: true }); await rm(LOG, { force: true }); });
after(async () => { await rm(INBOX, { force: true }); await rm(LOG, { force: true }); });

// A fake `complete` that returns whatever JSON object we hand it, in the shape textOf expects.
const fakeComplete = (obj) => async () => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

test("isTransactionAlert: matches bank alert senders with a transaction subject, rejects others", () => {
  assert.equal(isTransactionAlert({ from: "no.reply.alerts@chase.com", subject: "You made a transaction" }), true);
  assert.equal(isTransactionAlert({ from: "AmericanExpress@welcome.americanexpress.com", subject: "Large purchase approved" }), true);
  assert.equal(isTransactionAlert({ from: "newsletter@chase.com", subject: "Our spring rewards event" }), false); // bank sender, no txn subject/$
  assert.equal(isTransactionAlert({ from: "mom@gmail.com", subject: "dinner transaction" }), false); // not a bank sender
});

test("queue -> peek -> drain clears the inbox", async () => {
  await queueAlert({ from: "alerts@chase.com", subject: "purchase", body: "$12 at Cafe" });
  await queueAlert({ from: "alerts@chase.com", subject: "purchase", body: "$30 at Shop" });
  assert.equal((await peekAlerts()).length, 2);
  const drained = await drainAlerts();
  assert.equal(drained.length, 2);
  assert.equal((await peekAlerts()).length, 0);
});

test("extractTransactions maps model output to parsed rows and leftovers", async () => {
  const alerts = [
    { from: "alerts@chase.com", subject: "purchase", body: "$12.50 at Starbucks on your Sapphire" },
    { from: "alerts@chase.com", subject: "statement", body: "Your statement is ready" },
  ];
  const complete = fakeComplete({
    transactions: [{ i: 0, date: "2026-06-20", merchant: "Starbucks", amount: 12.5, card: "9634", source: "credit" }],
    unparsed: [1],
  });
  const { parsed, unparsed } = await extractTransactions(alerts, { complete });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].source, "credit");
  assert.equal(unparsed.length, 1);
});

test("extractTransactions prefers the alert's received date over the model's guess", async () => {
  // Real Chase alerts don't state a date; the model confabulated 2026-07-01 for a
  // June 29 alert. The received timestamp is authoritative.
  const alerts = [{ from: "alerts@chase.com", subject: "purchase", body: "$5 coffee", at: "2026-06-29T22:00:00-07:00" }];
  const complete = fakeComplete({ transactions: [{ i: 0, date: "2026-07-01", merchant: "Cafe", amount: 5, source: "credit" }] });
  const { parsed } = await extractTransactions(alerts, { complete });
  assert.equal(parsed[0].date, "2026-06-29"); // received (PT), not the model's 2026-07-01
});

test("extractTransactions chunks a large batch instead of one oversized call", async () => {
  const alerts = Array.from({ length: 20 }, (_, k) => ({ from: "alerts@chase.com", subject: "purchase", body: `$${k + 1} item`, at: "2026-06-28T12:00:00-07:00" }));
  let calls = 0;
  const complete = async () => { calls++; return { content: [{ type: "text", text: JSON.stringify({ transactions: [{ i: 0, amount: 1, source: "credit" }] }) }] }; };
  const { parsed } = await extractTransactions(alerts, { complete, chunkSize: 8 });
  assert.equal(calls, 3);          // ceil(20 / 8) — no single giant call to overflow max_tokens
  assert.equal(parsed.length, 3);  // one parsed row per chunk
});

test("buildDailyIngest logs parsed txns, runs a reconcile pass, and flags the rest", async () => {
  await queueAlert({ from: "alerts@chase.com", subject: "purchase", body: "$12.50 Starbucks credit" });
  await queueAlert({ from: "no.reply.alerts@chase.com", subject: "debit", body: "$99.51 Ralphs checking 1857" });
  await queueAlert({ from: "alerts@chase.com", subject: "weird", body: "indecipherable" });

  // First pass parses 2 (one credit, one checking), leaves index 2 unparsed.
  // Reconcile pass (called on the 1 leftover) parses nothing -> it stays flagged.
  let call = 0;
  const complete = async () => {
    call++;
    if (call === 1) {
      return { content: [{ type: "text", text: JSON.stringify({
        transactions: [
          { i: 0, amount: 12.5, merchant: "Starbucks", source: "credit", date: "2026-06-20" },
          { i: 1, amount: 99.51, merchant: "Ralphs", source: "checking", date: "2026-06-20" },
        ], unparsed: [2],
      }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ transactions: [], unparsed: [0] }) }] };
  };

  const r = await buildDailyIngest({ complete });
  assert.equal(r.alerts, 3);
  assert.equal(r.logged, 2);
  assert.equal(r.flagged.length, 1);

  const logged = await listTransactions({});
  assert.equal(logged.length, 2);
  assert.equal((await listTransactions({ source: "checking" })).length, 1);
  assert.equal((await listTransactions({ source: "credit" })).length, 1);
});
