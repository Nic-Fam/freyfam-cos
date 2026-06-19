import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-proposals-test.json");
process.env.PROPOSALS_PATH = TMP;
const { addProposal, listProposals } = await import("../src/proposals.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("propose -> list", async () => {
  const p = await addProposal({ title: "Add local Playwright", steps: ["npm i playwright", "wire ordering"] });
  assert.ok(p.id);
  assert.equal(p.status, "proposed");
  const all = await listProposals();
  assert.equal(all.length, 1);
  assert.equal(all[0].title, "Add local Playwright");
  assert.equal(all[0].steps.length, 2);
});

test("title is required", async () => {
  await assert.rejects(() => addProposal({ rationale: "no title" }));
});
