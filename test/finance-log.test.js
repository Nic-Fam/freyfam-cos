import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-finance-log-test.json");
process.env.FINANCE_LOG_PATH = TMP;
const { logTransaction, identifyTransaction, listTransactions, summarizeSpend, formatSpend } = await import("../src/finance-log.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("identifyTransaction tags an untagged withdrawal so it's no longer unnamed", async () => {
  const t = await logTransaction({ amount: 744.65, date: "2026-06-30", source: "checking", direction: "out" });
  assert.equal(t.merchant, null);
  const r = await identifyTransaction({ amount: 744.65, date: "2026-06-30", source: "checking", merchant: "Landlord", note: "July rent" });
  assert.equal(r.count, 1);
  assert.equal(r.updated.merchant, "Landlord");
  assert.equal(r.updated.id, t.id, "same row, id preserved");
  const stored = (await listTransactions({})).find((x) => x.id === t.id);
  assert.equal(stored.merchant, "Landlord");
  assert.equal(stored.note, "July rent");
});

test("identifyTransaction refuses an ambiguous amount-only match", async () => {
  await logTransaction({ amount: 216, date: "2026-06-30", source: "checking" });
  await logTransaction({ amount: 216, date: "2026-06-29", source: "checking" });
  const r = await identifyTransaction({ amount: 216, merchant: "Sitter" });
  assert.equal(r.updated, null);
  assert.equal(r.count, 2, "two matches -> ask for the date instead of guessing");
});

test("log -> list round-trips, newest first", async () => {
  const a = await logTransaction({ amount: 12.5, merchant: "Starbucks", card: "Sapphire", category: "food_and_drink", date: "2026-06-20" });
  assert.ok(a.id);
  assert.equal(a.amount, 12.5);
  assert.equal(a.merchant, "Starbucks");
  await logTransaction({ amount: 99.51, merchant: "Ralphs", category: "groceries", date: "2026-06-21" });

  const all = await listTransactions();
  assert.equal(all.length, 2);
  assert.equal(all[0].merchant, "Ralphs"); // newest (logged last) first
});

test("amount is required", async () => {
  await assert.rejects(() => logTransaction({ merchant: "No Amount" }), /amount is required/);
});

test("list filters by card and merchant", async () => {
  await logTransaction({ amount: 10, merchant: "Uber Eats", card: "Sapphire" });
  await logTransaction({ amount: 20, merchant: "Costco", card: "Sapphire" });
  await logTransaction({ amount: 30, merchant: "Target", card: "Capital One" });

  assert.equal((await listTransactions({ card: "sapphire" })).length, 2);
  assert.equal((await listTransactions({ merchant: "costco" })).length, 1);
});

test("summarizeSpend rolls up totals + category + duplicates over the window", async () => {
  await logTransaction({ amount: 50, merchant: "Uber Eats", category: "food_and_drink" });
  await logTransaction({ amount: 50, merchant: "Uber Eats", category: "food_and_drink" }); // duplicate
  await logTransaction({ amount: 100, merchant: "Ralphs", category: "groceries" });

  const s = await summarizeSpend({ sinceDays: 30 });
  assert.equal(s.count, 3);
  assert.equal(s.total, 200);
  assert.equal(s.totalsByCategory.food_and_drink, 100);
  assert.equal(s.totalsByCategory.groceries, 100);
  assert.ok(s.duplicates.length >= 1, "same merchant+amount flagged as duplicate");
});

test("formatSpend is readable, and empty window is handled", async () => {
  assert.match(formatSpend(await summarizeSpend({ sinceDays: 7 })), /No transactions logged/);
  await logTransaction({ amount: 42.0, merchant: "Netflix", category: "bills" });
  const line = formatSpend(await summarizeSpend({ sinceDays: 7 }));
  assert.match(line, /Last 7d: 1 charges, \$42\.00 total/);
  assert.match(line, /bills \$42\.00/);
});
