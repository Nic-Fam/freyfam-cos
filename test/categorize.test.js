import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const RULES = join(os.tmpdir(), "cos-cat-rules.json");
const INBOX = join(os.tmpdir(), "cos-cat-inbox.json");
const LOG = join(os.tmpdir(), "cos-cat-log.json");
process.env.CATEGORY_RULES_PATH = RULES;
process.env.FINANCE_INBOX_PATH = INBOX;
process.env.FINANCE_LOG_PATH = LOG;
const { categorize, addCategoryRule, loadCategoryRules } = await import("../src/categorize.js");
const { queueAlert, buildDailyIngest } = await import("../src/finance-ingest.js");
const { listTransactions } = await import("../src/finance-log.js");

const clean = async () => { for (const f of [RULES, INBOX, LOG]) await rm(f, { force: true }); };
beforeEach(clean);
after(clean);

test("builtin: Zelle -> services; non-Zelle stays uncategorized", () => {
  assert.equal(categorize({ merchant: "John Smith", text: "You sent $200 to John Smith with Zelle" })?.category, "services");
  assert.equal(categorize({ merchant: "SEES CANDIES", text: "You made a $73.00 transaction" }), null);
  assert.equal(categorize({}), null);
});

test("stored payee rule wins over builtin and carries its note", async () => {
  await addCategoryRule({ pattern: "\\blulu\\b", category: "services", note: "house cleaning (Lulu)", source: "checking" });
  const rules = await loadCategoryRules();
  const hit = categorize({ merchant: "Lulu", text: "You sent $170 to Lulu with Zelle", source: "checking" }, rules);
  assert.equal(hit.category, "services");
  assert.equal(hit.note, "house cleaning (Lulu)");
});

test("source-scoped rule does not match the other side (no card false-positive)", async () => {
  await addCategoryRule({ pattern: "\\bjuan\\b", category: "services", note: "car detail (Juan)", source: "checking" });
  const rules = await loadCategoryRules();
  // a CREDIT card purchase at "Juan's Tacos" must NOT be tagged services
  assert.equal(categorize({ merchant: "JUANS TACOS", text: "purchase", source: "credit" }, rules), null);
  // a CHECKING Zelle to Juan does
  assert.equal(categorize({ merchant: "Juan", text: "Zelle", source: "checking" }, rules)?.category, "services");
});

test("ingest applies the rules with source + note", async () => {
  await addCategoryRule({ pattern: "\\blulu\\b", category: "services", note: "house cleaning (Lulu)", source: "checking" });
  await queueAlert({ from: "no.reply.alerts@chase.com", subject: "You sent money with Zelle", body: "You sent $170.00 to Lulu with Zelle from checking." });
  const fakeComplete = async () => ({ content: [{ type: "text", text: '{"transactions":[{"i":0,"date":"2026-06-28","merchant":"Lulu","amount":170,"source":"checking","direction":"out"}],"unparsed":[]}' }] });
  const r = await buildDailyIngest({ complete: fakeComplete });
  assert.equal(r.logged, 1);
  const tx = (await listTransactions({}))[0];
  assert.equal(tx.category, "services");
  assert.equal(tx.note, "house cleaning (Lulu)");
});
