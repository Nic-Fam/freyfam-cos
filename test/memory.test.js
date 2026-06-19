import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-brain-test.json");
process.env.BRAIN_PATH = TMP;
const { remember, recall, rememberOnce } = await import("../src/memory.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("agent-scoped recall isolates specialists but shares unscoped facts", async () => {
  await remember("Shelli hunts Margiela Tabi", { agent: "resale" });
  await remember("Electric bill spiked in June", { agent: "finance" });
  await remember("Family timezone is America/Los_Angeles"); // shared (no agent)

  const financeTexts = (await recall("anything", 10, { agent: "finance" })).map((h) => h.text);
  assert.ok(financeTexts.some((t) => t.includes("Electric")), "own-domain memory present");
  assert.ok(financeTexts.some((t) => t.includes("timezone")), "shared memory visible");
  assert.ok(!financeTexts.some((t) => t.includes("Margiela")), "other-domain memory must not leak");

  const all = await recall("anything", 10); // chief of staff: no scope -> everything
  assert.equal(all.length, 3);
});

test("recall ranks by lexical relevance (TF-IDF), not just presence", async () => {
  await remember("Nic's work email is nicholas.frey@flyerdefense.com");
  await remember("Trash pickup is Tuesday");
  await remember("Shelli prefers oat milk");

  const top = await recall("what is Nic's work email", 3);
  assert.ok(top[0].text.includes("work email"), "most relevant fact ranks first");
  assert.ok(top[0].score > top[2].score, "relevance scores are ordered, not flat");
});

test("rememberOnce skips exact-duplicate text so seeding is idempotent", async () => {
  assert.equal(await rememberOnce("Trash pickup is Tuesday"), true, "first write lands");
  assert.equal(await rememberOnce("Trash pickup is Tuesday"), false, "duplicate skipped");
  assert.equal(await rememberOnce("Recycling is every other Friday"), true, "distinct fact lands");

  const all = await recall("anything", 10);
  assert.equal(all.length, 2, "no duplicate piled up");
});
