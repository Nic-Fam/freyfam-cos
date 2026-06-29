import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { categorize } from "../src/categorize.js";

test("Zelle payments categorize as services; non-Zelle stays uncategorized", () => {
  assert.equal(categorize({ merchant: "John Smith", text: "You sent $200.00 to John Smith with Zelle" }), "services");
  assert.equal(categorize({ merchant: "Zelle payment", text: "" }), "services");
  assert.equal(categorize({ merchant: "SEES CANDIES", text: "You made a $73.00 transaction" }), null);
  assert.equal(categorize({}), null);
});

// buildDailyIngest applies the category from the alert text (where "Zelle" appears).
const INBOX = join(os.tmpdir(), "cos-cat-inbox.json");
const LOG = join(os.tmpdir(), "cos-cat-log.json");
process.env.FINANCE_INBOX_PATH = INBOX;
process.env.FINANCE_LOG_PATH = LOG;
const { queueAlert, buildDailyIngest } = await import("../src/finance-ingest.js");
const { listTransactions } = await import("../src/finance-log.js");

const clean = async () => { await rm(INBOX, { force: true }); await rm(LOG, { force: true }); };
beforeEach(clean);
after(clean);

test("ingest tags a Zelle alert as services", async () => {
  await queueAlert({ from: "no.reply.alerts@chase.com", subject: "You sent money with Zelle", body: "You sent $150.00 to Maria (cleaner) with Zelle from your checking account." });
  // a fake extractor that returns the Zelle payment (no category - the rule supplies it)
  const fakeComplete = async () => ({ content: [{ type: "text", text: '{"transactions":[{"i":0,"date":"2026-06-28","merchant":"Maria","amount":150,"source":"checking","direction":"out"}],"unparsed":[]}' }] });
  const r = await buildDailyIngest({ complete: fakeComplete });
  assert.equal(r.logged, 1);
  const tx = await listTransactions({});
  assert.equal(tx[0].category, "services");
  assert.equal(tx[0].source, "checking");
});
