import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm, readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const DIR = join(os.tmpdir(), "cos-decisions-test");
process.env.DECISIONS_DIR = DIR;
const { logDecision, listDecisions } = await import("../src/decisions.js");

beforeEach(() => rm(DIR, { recursive: true, force: true }));
after(() => rm(DIR, { recursive: true, force: true }));

test("logDecision persists a record and listDecisions returns it newest-first", async () => {
  await logDecision("finance", { title: "Skip the subscription audit", decision: "Defer to next month", rationale: "No spend spike this cycle" });
  await logDecision("finance", { title: "Flag duplicate charge", decision: "Surface the $42 double charge to Nic" });

  const items = await listDecisions("finance");
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Flag duplicate charge", "newest first");
  assert.equal(items[1].rationale, "No spend spike this cycle");
  assert.ok(items[0].id && items[0].createdAt, "id + timestamp stamped");
});

test("decisions are scoped per agent", async () => {
  await logDecision("finance", { title: "F", decision: "finance call" });
  await logDecision("chef", { title: "C", decision: "chef call" });

  assert.equal((await listDecisions("finance")).length, 1);
  assert.equal((await listDecisions("chef")).length, 1);
  assert.equal((await listDecisions("dev")).length, 0, "unwritten agent is empty");
});

test("a human-readable decision.md is regenerated alongside the JSON", async () => {
  await logDecision("dev", { title: "Pin Node 22", decision: "Set engines.node to >=22", rationale: "ESM + test runner" });
  const md = await readFile(join(DIR, "dev.md"), "utf8");
  assert.ok(md.includes("# Decision log: dev"));
  assert.ok(md.includes("Pin Node 22"));
  assert.ok(md.includes("**Why:** ESM + test runner"));
});

test("title and decision are required; agent key is sanitized", async () => {
  await assert.rejects(() => logDecision("finance", { title: "", decision: "x" }), /title is required/);
  await assert.rejects(() => logDecision("finance", { title: "x", decision: "" }), /decision is required/);
  await assert.rejects(() => logDecision("../etc", { title: "x", decision: "y" }), /invalid agent key/);
});
