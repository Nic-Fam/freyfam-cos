import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-reminders-test.json");
process.env.REMINDERS_PATH = TMP;
const r = await import("../src/reminders.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("a one-shot reminder is due at/after fireAt and marks fired (not re-armed)", async () => {
  const fireAt = "2026-06-25T17:00:00.000Z";
  await r.createReminder({ message: "take out trash", fireAt });
  assert.equal((await r.getDueReminders(new Date("2026-06-25T16:59:00Z"))).length, 0); // before
  const due = await r.getDueReminders(new Date("2026-06-25T17:30:00Z"));
  assert.equal(due.length, 1);
  await r.afterFired(due[0].id);
  assert.equal((await r.getDueReminders(new Date("2026-06-26T00:00:00Z"))).length, 0); // not re-armed
  assert.equal((await r.listReminders()).length, 0);
});

test("a recurring reminder re-arms to the next occurrence", async () => {
  const { reminder } = await r.createReminder({ message: "daily standup", fireAt: "2026-06-25T16:00:00.000Z", recurrence: "daily" });
  await r.afterFired(reminder.id);
  const pending = await r.listReminders();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].fireAt, "2026-06-26T16:00:00.000Z"); // +1 day
});

test("createReminder dedupes the same message+time among unfired", async () => {
  await r.createReminder({ message: "x", fireAt: "2026-06-25T17:00:00.000Z" });
  const second = await r.createReminder({ message: "x", fireAt: "2026-06-25T17:00:00.000Z" });
  assert.equal(second.deduped, true);
  assert.equal((await r.listReminders()).length, 1);
});

test("nextOccurrence: weekdays skips the weekend", () => {
  // 2026-06-26 is a Friday -> next weekday is Monday 2026-06-29.
  assert.equal(r.nextOccurrence("2026-06-26T16:00:00.000Z", "weekdays"), "2026-06-29T16:00:00.000Z");
});

test("createReminder rejects a bad time", async () => {
  await assert.rejects(() => r.createReminder({ message: "x", fireAt: "not-a-date" }), /valid ISO/);
});
