import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-tasks-test.json");
process.env.TASKS_PATH = TMP;
const t = await import("../src/tasks.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("add, list (open only), and complete a task", async () => {
  const a = await t.addTask({ title: "Call the pediatrician", owner: "Shelli" });
  assert.match(a.id, /^[0-9a-f]{8}$/);
  let open = await t.listTasks();
  assert.equal(open.length, 1);
  const done = await t.completeTask(a.id);
  assert.equal(done.status, "done");
  assert.equal((await t.listTasks()).length, 0); // open list excludes done
  assert.equal((await t.listTasks({ includeDone: true })).length, 1);
});

test("addTask dedups an open task and a recently-completed one (the digest resurrection bug)", async () => {
  const a = await t.addTask({ title: "Follow up: email Deborah re: tour", dueDate: "2026-06-20" });
  // same title again while open -> no duplicate
  const b = await t.addTask({ title: "follow up: email deborah re: tour", dueDate: "2026-06-21" });
  assert.equal(b.deduped, true);
  assert.equal(b.id, a.id);
  assert.equal((await t.listTasks({ includeDone: true })).length, 1);
  // complete it, then the digest re-derives it next morning -> still no new open dup
  await t.completeTask(a.id);
  const c = await t.addTask({ title: "Follow up: email Deborah re: tour", dueDate: "2026-07-01" });
  assert.equal(c.deduped, true);
  assert.equal(c.status, "done");
  assert.equal((await t.listTasks()).length, 0, "no resurrected open duplicate");
  // a genuinely different task still gets created
  const d = await t.addTask({ title: "Buy milk" });
  assert.ok(!d.deduped);
});

test("addTask re-creates a task completed long ago (beyond the dedup window)", async () => {
  const oldNow = Date.parse("2026-01-01T00:00:00Z");
  const a = await t.addTask({ title: "Annual smoke detector check" }, oldNow);
  await t.completeTask(a.id, oldNow);
  const again = await t.addTask({ title: "Annual smoke detector check" }); // now = today, >30d later
  assert.ok(!again.deduped, "old completion no longer blocks re-adding");
  assert.equal(again.status, "open");
});

test("completeTask closes by an unambiguous keyword, refuses ambiguous", async () => {
  await t.addTask({ title: "Follow up: tour response for 906 Whitehaven Ter, Glendale" });
  await t.addTask({ title: "Follow up: 1205 Geneva St Glendale -- await agent response" });
  // ambiguous keyword while BOTH open -> refuse to guess
  assert.equal(await t.completeTask("glendale"), null);
  assert.equal((await t.listTasks()).length, 2, "nothing closed on an ambiguous match");
  // unique keyword closes the right one
  const done = await t.completeTask("whitehaven");
  assert.ok(done && /Whitehaven/.test(done.title));
  assert.equal((await t.listTasks()).length, 1);
});

test("listTasks sorts overdue first, then by due date, undated last", async () => {
  const now = new Date("2026-06-22T19:00:00Z"); // June 22 PT
  await t.addTask({ title: "no date" });
  await t.addTask({ title: "future", dueDate: "2026-06-30" });
  await t.addTask({ title: "overdue", dueDate: "2026-06-20" });
  await t.addTask({ title: "today", dueDate: "2026-06-22" });
  const order = (await t.listTasks({}, now)).map((x) => x.title);
  assert.deepEqual(order, ["overdue", "today", "future", "no date"]);
});

test("formatTasks flags overdue and due-today", async () => {
  const now = new Date("2026-06-22T19:00:00Z");
  await t.addTask({ title: "late one", dueDate: "2026-06-20" });
  const out = t.formatTasks(await t.listTasks({}, now), now);
  assert.match(out, /late one \(OVERDUE, due 2026-06-20\)/);
});

test("formatTasks numbers each task 1., 2., 3. in list order", async () => {
  const now = new Date("2026-06-22T19:00:00Z");
  await t.addTask({ title: "future", dueDate: "2026-06-30" });
  await t.addTask({ title: "overdue", dueDate: "2026-06-20" });
  const out = t.formatTasks(await t.listTasks({}, now), now);
  assert.match(out, /^1\. overdue/m); // overdue sorts first
  assert.match(out, /^2\. future/m);
});

test("completeTask resolves a numeric index into the sorted open list ('done 2')", async () => {
  const now = new Date("2026-06-22T19:00:00Z");
  await t.addTask({ title: "no date" });
  await t.addTask({ title: "future", dueDate: "2026-06-30" });
  await t.addTask({ title: "overdue", dueDate: "2026-06-20" });
  await t.addTask({ title: "today", dueDate: "2026-06-22" });
  // sorted order: [overdue, today, future, no date] -> "done 2" == "today"
  const done = await t.completeTask("2", now);
  assert.ok(done && done.title === "today", "index 2 maps to the 2nd listed task");
  assert.equal((await t.listTasks({}, now)).length, 3, "exactly one closed");
});

test("a 3+ digit number is NOT treated as an index (won't hijack a numeric id)", async () => {
  await t.addTask({ title: "task A" });
  assert.equal(await t.completeTask("999"), null); // not a 1-2 digit index, not an id/title
  assert.equal((await t.listTasks()).length, 1, "nothing closed");
});

test("completeTask returns null when nothing matches", async () => {
  assert.equal(await t.completeTask("nope"), null);
});
