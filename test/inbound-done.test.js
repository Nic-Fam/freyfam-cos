import { test, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const DIR = join(os.tmpdir(), `cos-inbound-done-${process.pid}`);
process.env.TASKS_PATH = join(DIR, "tasks.json");
process.env.TASK_SNAPSHOTS_PATH = join(DIR, "snaps.json");
process.env.CONVO_PATH = join(DIR, "convo.json");
process.env.PENDING_APPROVALS_PATH = join(DIR, "pending.json");

const { handleInbound, recallQueryFor, recentActivityBlock } = await import("../src/orchestrator.js");
const t = await import("../src/tasks.js");
const { getThread } = await import("../src/conversation.js");
after(() => rm(DIR, { recursive: true, force: true }));

const PASS = async () => ["spf=pass; dkim=pass; dmarc=pass action=none header.from=freyfam.com; compauth=pass reason=100"];

test("an emailed 'done 1, 3' closes the digest's items 1 and 3 with no model run, and is remembered in the thread", async () => {
  const now = Date.now();
  await t.addTask({ title: "Follow up: email Deborah re: Fairview tour", dueDate: "2026-10-24" }, now);
  await t.addTask({ title: "Follow up: get plumber quote" }, now);
  await t.addTask({ title: "Follow up: return school form" }, now);
  const listed = await t.listTasks();
  await t.saveTaskSnapshot(listed.map((x) => x.id), { source: "digest" });

  const replies = [];
  await handleInbound(
    { channel: "email", from: "nic@freyfam.com", subject: "Re: Morning digest", body: "done 1, 3\n\nOn Mon, Lloyd wrote:\n> To do:", graphMessageId: "AAMk-1" },
    { reply: async (x) => void replies.push(x), mirror: async () => {} },
    { authHeaders: PASS }
  );
  assert.equal(replies.length, 1);
  assert.match(replies[0], /^Marked done: 1\. Follow up: email Deborah re: Fairview tour; 3\. Follow up: return school form\.$/);
  assert.deepEqual((await t.listTasks()).map((x) => x.title), ["Follow up: get plumber quote"]);
  const th = await getThread("person:nic");
  assert.equal(th.messages.at(-1).content, replies[0], "the exchange is in Nic's thread");
});

test("recallQueryFor: real questions recall on themselves; acknowledgements borrow the thread's topic or skip", () => {
  assert.equal(recallQueryFor("when is the Fairview tour again?"), "when is the Fairview tour again?");
  assert.equal(recallQueryFor("yes do that", []), null);
  assert.equal(recallQueryFor("ok", [{ role: "user", content: "can you find a dinner spot near Fairview" }]), "can you find a dinner spot near Fairview ok");
});

test("recentActivityBlock lists the last 48h of actions and task changes", async () => {
  const now = Date.parse("2026-10-27T18:00:00Z");
  const block = await recentActivityBlock({
    now,
    actions: async () => [{ at: "2026-10-27T16:00:00Z", kind: "email", summary: "Sent email to deborah@realty.com" }],
    tasks: async () => [
      { title: "Follow up: plumber", status: "done", completedAt: "2026-10-27T17:00:00Z", createdAt: "2026-10-20T00:00:00Z" },
      { title: "Old thing", status: "done", completedAt: "2026-10-10T00:00:00Z" },
    ],
  });
  assert.match(block, /did: email: Sent email to deborah@realty.com/);
  assert.match(block, /task done: Follow up: plumber/);
  assert.doesNotMatch(block, /Old thing/);
});
