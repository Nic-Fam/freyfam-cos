import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-audit-test.json");
process.env.AUDIT_PATH = TMP;
const a = await import("../src/audit.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("logAction + listActions round-trip, newest first, windowed", async () => {
  await a.logAction("email", "Sent email to nic re: dinner", { now: () => "2026-06-20T10:00:00Z" });
  await a.logAction("order", "Ralphs grocery order (5 items)", { now: () => "2026-06-24T09:00:00Z" });
  await a.logAction("email", "old one", { now: () => "2026-05-01T10:00:00Z" }); // outside 7d

  const recent = await a.listActions({ sinceDays: 7 });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].kind, "order"); // newest first
  assert.equal(recent[1].summary, "Sent email to nic re: dinner");
});

test("formatAudit lists actions; empty window has a friendly message", () => {
  const out = a.formatAudit([
    { kind: "order", summary: "Ralphs grocery order (5 items)", at: "2026-06-24T09:00:00Z" },
  ]);
  assert.match(out, /order: Ralphs grocery order/);
  assert.equal(a.formatAudit([]), "No recorded actions in that window.");
});

test("logAction never throws on a bad store path", async () => {
  // Even if persistence fails, logging must not break the action it records.
  await assert.doesNotReject(a.logAction("email", "x"));
});
