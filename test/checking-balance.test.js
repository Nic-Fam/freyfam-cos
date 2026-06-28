import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const LOG = join(os.tmpdir(), "cos-cb-log.json");
const ANCHOR = join(os.tmpdir(), "cos-cb-anchor.json");
process.env.FINANCE_LOG_PATH = LOG;
process.env.CHECKING_ANCHOR_PATH = ANCHOR;
const { logTransaction } = await import("../src/finance-log.js");
const { getCheckingBalance, setCheckingAnchor, getCheckingAnchor } = await import("../src/checking-balance.js");

const clean = async () => { await rm(LOG, { force: true }); await rm(ANCHOR, { force: true }); };
beforeEach(clean);
after(clean);

test("no anchor -> balance is null", async () => {
  const r = await getCheckingBalance();
  assert.equal(r.balance, null);
  assert.equal(r.basis, "none");
});

test("manual anchor + signed checking flows", async () => {
  await setCheckingAnchor({ amount: 1000, asOf: "2020-01-01T00:00:00Z" });
  await logTransaction({ amount: 200, source: "checking", direction: "out", at: "2026-06-10T00:00:00Z" });
  await logTransaction({ amount: 500, source: "checking", direction: "in", at: "2026-06-11T00:00:00Z" });
  await logTransaction({ amount: 999, source: "credit", direction: "out", at: "2026-06-12T00:00:00Z" }); // credit ignored
  const r = await getCheckingBalance();
  assert.equal(r.basis, "manual");
  assert.equal(r.flowsApplied, 2);
  assert.equal(r.balance, 1300); // 1000 - 200 + 500
});

test("a bank-stated balance snapshot anchors, then later flows apply", async () => {
  await logTransaction({ amount: 50, source: "checking", direction: "out", balance: 5000, at: "2026-06-20T00:00:00Z" }); // snapshot AFTER this txn
  await logTransaction({ amount: 300, source: "checking", direction: "out", at: "2026-06-21T00:00:00Z" });
  await logTransaction({ amount: 100, source: "checking", direction: "in", at: "2026-06-22T00:00:00Z" });
  const r = await getCheckingBalance();
  assert.equal(r.basis, "bank-alert");
  assert.equal(r.anchorBalance, 5000);
  assert.equal(r.balance, 4800); // 5000 - 300 + 100
});

test("the more RECENT of snapshot vs manual anchor wins", async () => {
  await logTransaction({ amount: 10, source: "checking", direction: "out", balance: 5000, at: "2026-06-01T00:00:00Z" });
  await setCheckingAnchor({ amount: 2000, asOf: "2026-06-15T00:00:00Z" }); // newer than the snapshot
  await logTransaction({ amount: 200, source: "checking", direction: "out", at: "2026-06-20T00:00:00Z" });
  const r = await getCheckingBalance();
  assert.equal(r.basis, "manual");
  assert.equal(r.balance, 1800); // 2000 - 200 (the pre-anchor snapshot/flow is not re-applied)
});
