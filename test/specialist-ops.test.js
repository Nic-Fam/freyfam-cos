import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// Isolate the security + saved-search stores so the ops read local fixtures.
const FIND = join(os.tmpdir(), "cos-ops-findings.json");
const SS = join(os.tmpdir(), "cos-ops-searches.json");
process.env.SECURITY_FINDINGS_PATH = FIND;
process.env.SAVED_SEARCHES_PATH = SS;

const { runSpecialistOp, hasSpecialistOp } = await import("../src/specialists/ops.js");
const { addFinding } = await import("../src/security.js");
const { addSavedSearch } = await import("../src/saved-searches.js");

const clean = () => Promise.all([rm(FIND, { force: true }), rm(SS, { force: true })]);
beforeEach(clean);
after(clean);

test("hasSpecialistOp knows the registered ops and rejects the rest", () => {
  assert.equal(hasSpecialistOp("security", "list_findings"), true);
  assert.equal(hasSpecialistOp("resale", "export_saved_searches"), true);
  assert.equal(hasSpecialistOp("security", "delete_everything"), false);
  assert.equal(hasSpecialistOp("finance", "list_findings"), false);
});

test("security.list_findings returns open findings filtered by title prefix", async () => {
  await addFinding({ title: "New device on LAN: unknown-iphone", severity: "medium" });
  await addFinding({ title: "Failed login attempt", severity: "high" });
  const all = await runSpecialistOp("security", "list_findings", { status: "open" });
  assert.equal(all.length, 2);
  const devices = await runSpecialistOp("security", "list_findings", { status: "open", titlePrefix: "New device on LAN" });
  assert.equal(devices.length, 1);
  assert.match(devices[0].title, /unknown-iphone/);
});

test("resale.export_saved_searches returns the saved-search list", async () => {
  await addSavedSearch({ query: "Margiela Tabi", maxPrice: 350 });
  const list = await runSpecialistOp("resale", "export_saved_searches");
  assert.equal(list.length, 1);
  assert.equal(list[0].query, "Margiela Tabi");
});

test("an unknown op throws (so a typo can't silently no-op)", async () => {
  await assert.rejects(() => runSpecialistOp("security", "nope"), /no op "nope"/);
});
