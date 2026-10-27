import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), `cos-tasks-num-${process.pid}.json`);
const SNAP = join(os.tmpdir(), `cos-tasks-snap-${process.pid}.json`);
process.env.TASKS_PATH = TMP;
process.env.TASK_SNAPSHOTS_PATH = SNAP;
const t = await import("../src/tasks.js");

const NOW = new Date("2026-10-26T13:00:00Z"); // 6 AM PT
const clean = () => Promise.all([rm(TMP, { force: true }), rm(SNAP, { force: true })]);
beforeEach(clean);
after(clean);

async function seed() {
  await t.addTask({ title: "Follow up: email Deborah re: Fairview tour", dueDate: "2026-10-24" }, NOW.getTime());
  await t.addTask({ title: "Renew car registration", dueDate: "2026-10-28" }, NOW.getTime());
  await t.addTask({ title: "Follow up: get quote from plumber", dueDate: "2026-10-26" }, NOW.getTime());
  await t.addTask({ title: "Follow up: return school form" }, NOW.getTime());
  await t.addTask({ title: "Repaint the garage someday" }, NOW.getTime()); // undated, not a follow-up: not in the digest
}

test("the digest's numbered list is rendered in code and saved as a snapshot", async () => {
  await seed();
  const s = await t.digestTaskSection({ now: NOW });
  assert.match(s.text, /^To do:\n1\. Follow up: email Deborah re: Fairview tour \(overdue since 2026-10-24\)\n2\. Follow up: get quote from plumber \(due today\)\n3\. Renew car registration \(due 2026-10-28\)\n4\. Follow up: return school form/);
  assert.doesNotMatch(s.text, /Repaint/, "undated non-follow-ups stay off the digest");
  assert.equal((await t.latestTaskSnapshot({ now: NOW.getTime() })).ids.length, 4);
});

test("'done 1 and 3' closes exactly items 1 and 3 of the list shown (the wrong-task bug)", async () => {
  await seed();
  await t.digestTaskSection({ now: NOW });
  const r = await t.tryResolveDoneReply("done 1 and 3\n\nOn Mon, Lloyd wrote:\n> 1. ...", { now: NOW.getTime() });
  assert.equal(r.handled, true);
  assert.match(r.message, /Marked done: 1\. Follow up: email Deborah re: Fairview tour; 3\. Renew car registration\./);
  const open = (await t.listTasks({}, NOW)).map((x) => x.title);
  assert.ok(open.includes("Follow up: return school form"), "item 4 untouched");
  assert.ok(!open.includes("Renew car registration"));
});

test("numbers stay tied to the snapshot even if the live list changes during the day", async () => {
  await seed();
  await t.digestTaskSection({ now: NOW });
  await t.addTask({ title: "Follow up: call the bank", dueDate: "2026-10-20" }, NOW.getTime()); // would sort first live
  const r = await t.tryResolveDoneReply("done 2", { now: NOW.getTime() });
  assert.match(r.message, /2\. Follow up: get quote from plumber/);
});

test("'drop 4' marks a task dropped, not done", async () => {
  await seed();
  await t.digestTaskSection({ now: NOW });
  const r = await t.tryResolveDoneReply("drop 4", { now: NOW.getTime() });
  assert.match(r.message, /^Dropped: 4\. Follow up: return school form\./);
  const all = await t.listTasks({ includeDone: true }, NOW);
  assert.equal(all.find((x) => /school form/.test(x.title)).status, "dropped");
});

test("parseDoneReply accepts list replies and ignores everything else", () => {
  assert.deepEqual(t.parseDoneReply("Done 1, 3 and 4"), { outcome: "done", numbers: [1, 3, 4], all: false });
  assert.deepEqual(t.parseDoneReply("#2 done"), { outcome: "done", numbers: [2], all: false });
  assert.deepEqual(t.parseDoneReply("not needed 3"), { outcome: "dropped", numbers: [3], all: false });
  assert.deepEqual(t.parseDoneReply("done all"), { outcome: "done", numbers: [], all: true });
  for (const x of ["done Deborah", "yes 2", "Done!", "I'm done with 2 of these, call me", "YES A1B2C3"]) assert.equal(t.parseDoneReply(x), null, x);
});

test("a follow-up with the same source is never recreated, even reworded after it was closed", async () => {
  const a = await t.addTask({ title: "Follow up: email Deborah re: Fairview tour", source: "Fairview tour @ 2026-10-25" }, NOW.getTime());
  await t.completeTask(a.id, NOW.getTime());
  const later = NOW.getTime() + 40 * 864e5; // beyond the 30-day title window
  const b = await t.addTask({ title: "Follow up with Deborah about the open house", source: "Fairview Tour @ 2026-10-25" }, later);
  assert.equal(b.deduped, true);
});

test("a reworded follow-up is recognised without a source", async () => {
  const a = await t.addTask({ title: "Follow up: email Deborah re: Fairview tour" }, NOW.getTime());
  await t.completeTask(a.id, NOW.getTime());
  const b = await t.addTask({ title: "Follow up with Deborah about the Fairview tour" }, NOW.getTime() + 864e5);
  assert.equal(b.deduped, true, "same follow-up, different words");
  const c = await t.addTask({ title: "Follow up: Geneva St agent response" }, NOW.getTime() + 864e5);
  assert.ok(!c.deduped, "a different follow-up still lands");
});

test("stale follow-ups get one 'still needed?' then age out; family tasks never do", async () => {
  await t.addTask({ title: "Follow up: tour response for Whitehaven", dueDate: "2026-10-17" }, NOW.getTime()); // 9 days
  await t.addTask({ title: "Follow up: Geneva St quote", dueDate: "2026-10-05" }, NOW.getTime()); // 21 days
  await t.addTask({ title: "Buy a birthday gift for Gary", dueDate: "2026-10-01" }, NOW.getTime()); // family task
  const s = await t.digestTaskSection({ now: NOW });
  assert.match(s.text, /Whitehaven.*Still needed\? If not, reply 'drop \d'\./);
  assert.match(s.text, /Dropped as stale \(no reply in 14 days\): Follow up: Geneva St quote/);
  assert.match(s.text, /Buy a birthday gift for Gary \(overdue since 2026-10-01\)/);
  assert.doesNotMatch(s.text, /Gary.*Still needed/);
});

test("closeTasks refuses an ambiguous phrase rather than guessing", async () => {
  await t.addTask({ title: "Follow up: tour response for 906 Whitehaven Ter, Glendale" }, NOW.getTime());
  await t.addTask({ title: "Follow up: 1205 Geneva St Glendale agent" }, NOW.getTime());
  const r = await t.closeTasks(["glendale"], { now: NOW.getTime() });
  assert.deepEqual(r.ambiguous, ["glendale"]);
  assert.equal(r.closed.length, 0);
});

test("later lists reuse the digest's numbers and append new tasks, so every list agrees", async () => {
  await seed();
  await t.digestTaskSection({ now: NOW });
  await t.completeTask("Follow up: email Deborah re: Fairview tour", NOW.getTime());
  await t.addTask({ title: "Follow up: call the bank", dueDate: "2026-10-20" }, NOW.getTime());
  const entries = await t.currentNumbering({ now: NOW });
  const map = Object.fromEntries(entries.map((e) => [e.task.title, e.n]));
  assert.equal(map["Follow up: get quote from plumber"], 2, "keeps its digest number");
  assert.equal(map["Renew car registration"], 3);
  assert.equal(map["Follow up: email Deborah re: Fairview tour"], undefined, "closed tasks drop out but keep their slot");
  assert.ok(map["Follow up: call the bank"] > 4, "new tasks are appended, not inserted");
  assert.match(t.formatNumbered(entries, NOW), /^2\. Follow up: get quote from plumber/);
  // and "done 3" still means car registration
  const r = await t.tryResolveDoneReply("done 3", { now: NOW.getTime() });
  assert.match(r.message, /3\. Renew car registration/);
});
