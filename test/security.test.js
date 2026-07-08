import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-security-findings-test.json");
process.env.SECURITY_FINDINGS_PATH = TMP;
const { addFinding, listFindings, resolveFinding, SECURITY_SEVERITIES } = await import("../src/security.js");

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

test("re-logging an OPEN finding dedups: bumps count, no new row, flags deduped", async () => {
  const a = await addFinding({ title: "Apple ID OTP relay -- 1st distinct overnight occurrence", severity: "medium" });
  assert.equal(a.count, 1);
  // only the ordinal/number differs -> the signature collapses it to the same finding
  const b = await addFinding({ title: "Apple ID OTP relay -- 8th distinct overnight occurrence", severity: "medium" });
  assert.equal(b.deduped, true);
  assert.equal(b.id, a.id, "same finding, not a new one");
  assert.equal(b.count, 2);
  const all = await listFindings();
  assert.equal(all.length, 1, "still ONE row, not two");
});

test("dedup keeps the highest severity seen", async () => {
  await addFinding({ title: "Abnormal email volume from Nic", severity: "low" });
  const up = await addFinding({ title: "Abnormal email volume from Nic", severity: "high" });
  assert.equal(up.deduped, true);
  assert.equal(up.severity, "high");
});

test("a RESOLVED finding does not suppress a genuinely new recurrence", async () => {
  const a = await addFinding({ title: "Suspicious login from new device", severity: "high" });
  const db = JSON.parse(await (await import("node:fs/promises")).readFile(TMP, "utf8"));
  db.items[0].status = "resolved";
  await (await import("node:fs/promises")).writeFile(TMP, JSON.stringify(db));
  const b = await addFinding({ title: "Suspicious login from new device", severity: "high" });
  assert.notEqual(b.deduped, true, "resolved -> a fresh finding, not a dedup");
  assert.equal((await listFindings()).length, 2);
});

test("genuinely distinct findings still create separate rows", async () => {
  await addFinding({ title: "Phishing email impersonating the bank", severity: "high" });
  await addFinding({ title: "Router firmware is out of date", severity: "medium" });
  assert.equal((await listFindings()).length, 2);
});

test("resolveFinding marks a finding resolved by id", async () => {
  const a = await addFinding({ title: "New device on LAN: printer", severity: "medium" });
  const r = await resolveFinding(a.id, { note: "confirmed, baselined" });
  assert.equal(r.status, "resolved");
  assert.ok(r.resolvedAt);
  assert.equal(r.resolvedNote, "confirmed, baselined");
  const open = (await listFindings()).filter((f) => f.status === "open");
  assert.equal(open.length, 0, "no open findings left");
});

test("resolveFinding returns null for an unknown id; id is required", async () => {
  assert.equal(await resolveFinding("nope"), null);
  await assert.rejects(() => resolveFinding(""));
});

test("resolveFinding is idempotent and unblocks a fresh recurrence", async () => {
  const a = await addFinding({ title: "Suspicious login", severity: "high" });
  await resolveFinding(a.id);
  const again = await resolveFinding(a.id); // no-op, still returns it
  assert.equal(again.status, "resolved");
  // resolved -> a genuinely new recurrence is a fresh row, not a dedup
  const b = await addFinding({ title: "Suspicious login", severity: "high" });
  assert.notEqual(b.deduped, true);
  assert.equal((await listFindings()).length, 2);
});
