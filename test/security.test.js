import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-security-findings-test.json");
process.env.SECURITY_FINDINGS_PATH = TMP;
const { addFinding, listFindings, SECURITY_SEVERITIES } = await import("../src/security.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("log -> list a finding", async () => {
  const f = await addFinding({
    title: "Reused password on two accounts",
    severity: "high",
    summary: "Same password on email + bank",
    recommendation: "Rotate both; enable 2FA",
  });
  assert.ok(f.id);
  assert.equal(f.severity, "high");
  assert.equal(f.status, "open");
  const all = await listFindings();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, "Reused password on two accounts");
});

test("unknown severity falls back to info; title is required", async () => {
  const f = await addFinding({ title: "Odd login from new device", severity: "spicy" });
  assert.equal(f.severity, "info");
  assert.ok(SECURITY_SEVERITIES.includes(f.severity));
  await assert.rejects(() => addFinding({ summary: "no title" }));
});
