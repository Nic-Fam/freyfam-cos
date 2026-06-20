import { test, before, after } from "node:test";
import assert from "node:assert";
import { writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-house-rules-test.json");
process.env.HOUSE_RULES_PATH = TMP;
const { getHouseRules, formatHouseRules } = await import("../src/rules.js");

after(() => rm(TMP, { force: true }));

test("getHouseRules reads the rules array, trimming and dropping junk", async () => {
  await writeFile(TMP, JSON.stringify({ rules: ["  Rule one  ", "Rule two", "", 42, null] }));
  const rules = await getHouseRules();
  assert.deepEqual(rules, ["Rule one", "Rule two"]);
});

test("getHouseRules returns [] when the file is missing or malformed", async () => {
  await rm(TMP, { force: true });
  assert.deepEqual(await getHouseRules(), []);
  await writeFile(TMP, "not json");
  assert.deepEqual(await getHouseRules(), []);
});

test("formatHouseRules renders a bulleted block, empty string when none", () => {
  assert.equal(formatHouseRules([]), "");
  const out = formatHouseRules(["Add work emails for daytime appts", "Mark cleaning events free"]);
  assert.match(out, /House rules/);
  assert.match(out, /- Add work emails for daytime appts/);
  assert.match(out, /- Mark cleaning events free/);
});
