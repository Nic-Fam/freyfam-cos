import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-brain-test.json");
process.env.BRAIN_PATH = TMP;
const { remember, recall } = await import("../src/memory.js");

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
