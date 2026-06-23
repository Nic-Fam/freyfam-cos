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

test("completeTask returns null when nothing matches", async () => {
  assert.equal(await t.completeTask("nope"), null);
});
