import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), `cos-brain-notebook-${process.pid}.json`);
process.env.BRAIN_PATH = TMP;
process.env.EMBEDDINGS_PROVIDER = "none";
const { rememberFact, recall, forgetMatching, RECALL_MIN_SCORE } = await import("../src/memory.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("a newer fact supersedes the old one, and recall returns only the current version", async () => {
  await rememberFact("The Fairview house tour with Deborah is on Tuesday at 2pm.");
  const r = await rememberFact("The Fairview house tour moved to Thursday at 10am.", { supersedes: "Fairview house tour Tuesday 2pm" });
  assert.deepEqual(r.superseded, ["The Fairview house tour with Deborah is on Tuesday at 2pm."]);
  const hits = await recall("when is the Fairview tour?", 4);
  assert.deepEqual(hits.map((h) => h.text), ["The Fairview house tour moved to Thursday at 10am."]);
});

test("duplicates and near-duplicates are skipped", async () => {
  assert.equal((await rememberFact("Fox is allergic to tree nuts.")).saved, true);
  assert.equal((await rememberFact("fox is allergic to tree nuts")).deduped, true);
  assert.equal((await rememberFact("Shelli prefers aisle seats.")).saved, true);
});

test("the relevance floor keeps irrelevant facts out of a turn's context", async () => {
  await rememberFact("Fox is allergic to tree nuts.");
  await rememberFact("Nic prefers Ralphs over Vons.");
  assert.equal((await recall("done 2", 4, { minScore: RECALL_MIN_SCORE })).length, 0);
  assert.equal((await recall("done 2", 4)).length, 2, "default (tools, tests) still returns top-k");
});

test("forgetMatching removes a specific fact and refuses a vague phrase that hits many", async () => {
  await rememberFact("The plumber is Joe's Plumbing, 818-555-0101.");
  for (const x of ["Trash goes out Tuesday night.", "Recycling goes out Tuesday night.", "Yard waste goes out Tuesday night.", "Bulk pickup is the first Tuesday."]) await rememberFact(x);
  assert.deepEqual((await forgetMatching("Joe's Plumbing")).removed, ["The plumber is Joe's Plumbing, 818-555-0101."]);
  const vague = await forgetMatching("tuesday");
  assert.equal(vague.removed.length, 0);
  assert.equal(vague.ambiguous.length, 4);
});
