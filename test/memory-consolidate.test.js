import { test } from "node:test";
import assert from "node:assert";
import { newTurns, parseMemories, consolidateThread, consolidateIdleThreads } from "../src/memory-consolidate.js";

const T0 = Date.parse("2026-10-27T17:00:00Z");
const thread = {
  key: "person:nic",
  updatedAt: T0,
  consolidatedThrough: T0 - 10 * 3600e3,
  earlier: [{ role: "assistant", ts: T0 - 9 * 3600e3, text: "[Lloyd sent a morning digest] Good morning..." }],
  messages: [
    { role: "user", ts: T0 - 3600e3, content: "We toured 500 Fairview today and loved it, want to offer by Friday" },
    { role: "assistant", ts: T0 - 3600e3, content: "Great, I'll note it." },
    { role: "user", ts: T0 - 1800e3, content: "Also Fox can't have tree nuts anymore, doctor confirmed" },
    { role: "assistant", ts: T0 - 1800e3, content: "Noted." },
  ],
};

test("newTurns skips the digest broadcast and anything already consolidated", () => {
  const turns = newTurns(thread);
  assert.equal(turns.length, 4);
  assert.ok(!turns.some((t) => /morning digest/.test(t.text)));
  assert.equal(newTurns({ ...thread, consolidatedThrough: T0 }).length, 0);
});

test("consolidateThread saves household facts locally and specialist facts to the specialist", async () => {
  const household = [], specialist = [], marks = [];
  let prompt = "";
  const llm = async ({ messages }) => {
    prompt = messages[0].content;
    return { content: [{ type: "text", text: JSON.stringify({ memories: [
      { text: "On Oct 27, 2026 Nic and Shelli toured 500 Fairview Ave and loved it; they want to make an offer by Oct 30.", agent: null, supersedes: null },
      { text: "Fox must not have tree nuts (doctor confirmed Oct 27, 2026).", agent: "chef", supersedes: "Fox nut allergy unconfirmed" },
      { text: "short", agent: null },
    ] }) }] };
  };
  const r = await consolidateThread(thread, {
    now: T0 + 3 * 3600e3, llm,
    save: async (m) => { household.push(m); return { saved: true }; },
    saveFor: async (m) => { specialist.push(m); return { saved: true }; },
    mark: async (k, ts) => marks.push([k, ts]),
  });
  assert.match(prompt, /Today is 2026-10-27/);
  assert.equal(r.saved.length, 2, "the too-short item is dropped");
  assert.equal(household.length, 1);
  assert.equal(specialist[0].agent, "chef");
  assert.equal(specialist[0].supersedes, "Fox nut allergy unconfirmed");
  assert.deepEqual(marks, [["person:nic", T0 - 1800e3]]);
});

test("a thread with no substantive family turns costs no model call", async () => {
  let called = false;
  const quiet = { key: "k", updatedAt: T0, messages: [{ role: "user", ts: T0, content: "ok" }, { role: "assistant", ts: T0, content: "Done." }] };
  const r = await consolidateThread(quiet, { llm: async () => { called = true; }, mark: async () => {} });
  assert.equal(called, false);
  assert.match(r.skipped, /no substantive/);
});

test("only threads quiet for 2h+ with new turns are consolidated", async () => {
  const seen = [];
  await consolidateIdleThreads({
    now: T0 + 3 * 3600e3,
    threads: async () => [thread, { ...thread, key: "busy", updatedAt: T0 + 3 * 3600e3 - 60e3 }],
    consolidate: async (t) => { seen.push(t.key); return {}; },
  });
  assert.deepEqual(seen, ["person:nic"]);
});

test("parseMemories validates agents and caps the list", () => {
  const out = parseMemories({ memories: [{ text: "A long enough memory text here.", agent: "hacker" }] });
  assert.equal(out[0].agent, null);
  assert.deepEqual(parseMemories(null), []);
});
