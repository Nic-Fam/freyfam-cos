import { test, before, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// The split-brain fix: a specialist's memory, rules and finding closures are
// written by ops that run ON the specialist's side of the seam. Exercised here
// through the real LAN harness + delegate's remote transport, with isolated stores.
const DIR = join(os.tmpdir(), `cos-spec-ops-${process.pid}`);
process.env.BRAIN_PATH = join(DIR, "brain.json");
process.env.HOUSE_RULES_PATH = join(DIR, "house-rules.json");
process.env.SECURITY_FINDINGS_PATH = join(DIR, "findings.json");
process.env.DECISIONS_DIR = join(DIR, "decisions");
process.env.EMBEDDINGS_PROVIDER = "none";

const { createSpecialistServer } = await import("../deploy/specialists/local-server.mjs");
const { delegate } = await import("../src/delegate.js");
const { recall } = await import("../src/memory.js");
const { getAgentRules } = await import("../src/rules.js");
const { addFinding, listFindings } = await import("../src/security.js");
const { listDecisions } = await import("../src/decisions.js");
const { runSpecialistOp, hasSpecialistOp } = await import("../src/specialists/ops.js");

let server, cfg;
before(async () => {
  await rm(DIR, { recursive: true, force: true });
  server = createSpecialistServer({ pinnedAgent: "security", key: "k", log: { error() {}, info() {} } });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  cfg = { mode: "remote", timeoutMs: 5000, endpoints: { security: url }, keys: { security: "k" } };
});
after(async () => { server.close(); await rm(DIR, { recursive: true, force: true }); });

test("remember/forget/rules ops reach the specialist's own store over the seam", async () => {
  const r1 = await delegate({ agent: "security", op: "remember", args: { text: "The Ring doorbell is a known device on the LAN." } }, { cfg });
  assert.equal(r1.data.saved, true);
  const dup = await delegate({ agent: "security", op: "remember", args: { text: "The Ring doorbell is a known device on the LAN." } }, { cfg });
  assert.equal(dup.data.deduped, true, "a re-push is skipped");
  const hits = await recall("ring doorbell device", 3, { agent: "security" });
  assert.match(hits[0].text, /Ring doorbell/);

  const add = await delegate({ agent: "security", op: "add_rule", args: { text: "The family's own email volume is never a threat." } }, { cfg });
  assert.equal(add.data.added, true);
  assert.deepEqual((await delegate({ agent: "security", op: "list_rules" }, { cfg })).data, ["The family's own email volume is never a threat."]);
  assert.deepEqual(await getAgentRules("security"), ["The family's own email volume is never a threat."]);
  const rm1 = await delegate({ agent: "security", op: "remove_rule", args: { match: "1" } }, { cfg });
  assert.match(rm1.data.removed, /email volume/);

  const f = await delegate({ agent: "security", op: "forget", args: { match: "ring doorbell" } }, { cfg });
  assert.equal(f.data.removed.length, 1);
});

test("resolve_findings closes by topic, and records the closure where Frank looks", async () => {
  await addFinding({ title: "New device on LAN: ring-doorbell 192.168.1.44 [aa:bb:cc:dd:ee:01]", severity: "medium", summary: "MAC aa:bb:cc:dd:ee:01 vendor Ring" });
  await addFinding({ title: "New device on LAN: espressif-plug 192.168.1.45 [aa:bb:cc:dd:ee:02]", severity: "medium", summary: "MAC aa:bb:cc:dd:ee:02 vendor Espressif" });
  await addFinding({ title: "Breach exposure: nic@freyfam.com in Canva", severity: "high" });
  const r = await delegate({ agent: "security", op: "resolve_findings", args: { match: "the Ring device on the LAN", note: "that's our new doorbell", by: "nic@freyfam.com" } }, { cfg });
  assert.equal(r.data.closed.length, 1);
  assert.match(r.data.closed[0].title, /New device on LAN/);
  assert.equal(r.data.stillOpen.length, 2, "the other device and the unrelated breach stay open");
  const closed = (await listFindings()).find((x) => /New device/.test(x.title));
  assert.equal(closed.status, "resolved");
  assert.equal(closed.resolvedBy, "nic@freyfam.com");
  assert.equal(closed.resolvedNote, "that's our new doorbell");
  const decisions = await listDecisions("security");
  assert.match(decisions[0].title, /^Closed by nic@freyfam.com: New device on LAN/);
  const mem = await recall("closed new device LAN", 3, { agent: "security" });
  assert.ok(mem.some((m) => /^CLOSED by nic@freyfam.com/.test(m.text)), "Frank's memory carries the closure");
});

test("list_findings since returns only new or re-seen findings", async () => {
  const before = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await addFinding({ title: "Suspicious sign-in to Chase from Ohio", severity: "high" });
  const r = await runSpecialistOp("security", "list_findings", { status: "open", since: before });
  assert.deepEqual(r.map((f) => f.title), ["Suspicious sign-in to Chase from Ohio"]);
});

test("common ops exist for every agent; unknown or prototype names do not", () => {
  for (const a of ["finance", "chef", "resale", "dev", "security", "sasshey-coo"]) assert.equal(hasSpecialistOp(a, "remember"), true, a);
  assert.equal(hasSpecialistOp("security", "constructor"), false);
  assert.equal(hasSpecialistOp("chef", "resolve_findings"), false, "closure is Frank's op only");
});
