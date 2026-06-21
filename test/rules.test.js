import { test, before, after } from "node:test";
import assert from "node:assert";
import { writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-house-rules-test.json");
process.env.HOUSE_RULES_PATH = TMP;
const { getHouseRules, formatHouseRules, getAgentRules, formatAgentRules, addRule, removeRule } = await import("../src/rules.js");

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

test("getAgentRules reads only the named agent's rules, [] for unknown/none", async () => {
  await writeFile(TMP, JSON.stringify({
    rules: ["a chief rule"],
    agentRules: { chef: ["  no nuts for Fox  ", "", 7], security: ["never disarm without confirmation"] },
  }));
  assert.deepEqual(await getAgentRules("chef"), ["no nuts for Fox"]);
  assert.deepEqual(await getAgentRules("security"), ["never disarm without confirmation"]);
  assert.deepEqual(await getAgentRules("finance"), []); // no rules for this agent
});

test("getAgentRules returns [] when there is no agentRules block", async () => {
  await writeFile(TMP, JSON.stringify({ rules: ["a chief rule"] }));
  assert.deepEqual(await getAgentRules("chef"), []);
});

test("formatAgentRules renders a bulleted block, empty string when none", () => {
  assert.equal(formatAgentRules([]), "");
  const out = formatAgentRules(["no nuts for Fox"]);
  assert.match(out, /standing rules/i);
  assert.match(out, /- no nuts for Fox/);
});

test("addRule writes house + per-agent rules, creating the file, and getters read them back", async () => {
  await rm(TMP, { force: true }); // start from no file
  const a = await addRule("  Always confirm before booking travel  ");
  assert.deepEqual(a, { added: true, scope: "house", text: "Always confirm before booking travel" });
  await addRule("Never plan a meal with nuts for Fox", { agent: "chef" });

  assert.deepEqual(await getHouseRules(), ["Always confirm before booking travel"]);
  assert.deepEqual(await getAgentRules("chef"), ["Never plan a meal with nuts for Fox"]);
});

test("addRule is idempotent on exact text and rejects unknown agents", async () => {
  await rm(TMP, { force: true });
  await addRule("rule one", { agent: "chef" });
  const dup = await addRule("rule one", { agent: "chef" });
  assert.equal(dup.added, false);
  assert.deepEqual(await getAgentRules("chef"), ["rule one"]);
  await assert.rejects(() => addRule("x", { agent: "chiff" }), /unknown agent/);
});

test("removeRule removes by 1-based index or exact text, preserving the rest", async () => {
  await rm(TMP, { force: true });
  await addRule("first");
  await addRule("second");
  await addRule("third");
  assert.equal(await removeRule(2), "second"); // by index
  assert.deepEqual(await getHouseRules(), ["first", "third"]);
  assert.equal(await removeRule("first"), "first"); // by exact text
  assert.deepEqual(await getHouseRules(), ["third"]);
  assert.equal(await removeRule("nope"), null); // no match
});

test("addRule preserves unrelated keys already in the file", async () => {
  await rm(TMP, { force: true });
  await writeFile(TMP, JSON.stringify({ _comment: "keep me", rules: ["existing"] }));
  await addRule("added", { agent: "security" });
  const { readFile } = await import("node:fs/promises");
  const data = JSON.parse(await readFile(TMP, "utf8"));
  assert.equal(data._comment, "keep me");
  assert.deepEqual(data.rules, ["existing"]);
  assert.deepEqual(data.agentRules.security, ["added"]);
});
