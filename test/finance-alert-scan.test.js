import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const INBOX = join(os.tmpdir(), "cos-fa-inbox.json");
const SEEN = join(os.tmpdir(), "cos-fa-seen.json");
process.env.FINANCE_INBOX_PATH = INBOX;
process.env.FINANCE_ALERT_SEEN_PATH = SEEN;
const { scanInboxForAlerts, peekAlerts } = await import("../src/finance-ingest.js");

const clean = async () => { await rm(INBOX, { force: true }); await rm(SEEN, { force: true }); };
beforeEach(clean);
after(clean);

const chase = (subject, receivedAt) => ({ from: "no.reply.alerts@chase.com", subject, body: "You made a $73.00 transaction", receivedAt });

test("queues transaction alerts and ignores non-alert mail", async () => {
  const mails = [
    chase("You made a $73.00 transaction with SEES CANDIES", "2026-06-28T10:00:00Z"),
    { from: "friend@example.com", subject: "lunch?", body: "you around", receivedAt: "2026-06-28T11:00:00Z" },
    chase("You made a $27.42 transaction with DisneyStore", "2026-06-28T12:00:00Z"),
  ];
  const r = await scanInboxForAlerts(mails);
  assert.equal(r.queued, 2);
  assert.equal((await peekAlerts()).length, 2);
});

test("re-scanning the same inbox does not double-queue", async () => {
  const mails = [chase("You made a $73.00 transaction", "2026-06-28T10:00:00Z")];
  await scanInboxForAlerts(mails);
  const again = await scanInboxForAlerts(mails); // same message seen on the next tick
  assert.equal(again.queued, 0);
  assert.equal((await peekAlerts()).length, 1);
});

test("a genuinely new alert still queues after earlier ones were seen", async () => {
  await scanInboxForAlerts([chase("txn A", "2026-06-28T10:00:00Z")]);
  const r = await scanInboxForAlerts([
    chase("txn A", "2026-06-28T10:00:00Z"), // already seen
    chase("txn B", "2026-06-29T10:00:00Z"), // new
  ]);
  assert.equal(r.queued, 1);
  assert.equal((await peekAlerts()).length, 2);
});
