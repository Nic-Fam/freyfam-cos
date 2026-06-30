import { test, beforeEach } from "node:test";
import assert from "node:assert";

// OWNER_PHONE is unset in the test env, so the SMS leg is skipped (no network) and
// we can assert purely on the registered live channels.
const { notifyOwner, registerOwnerNotifier, _clearOwnerNotifiers } = await import("../src/owner-notify.js");

beforeEach(() => _clearOwnerNotifiers());

test("notifyOwner fans out to every registered live channel", async () => {
  const got = {};
  registerOwnerNotifier("slack", ({ text }) => { got.slack = text; });
  registerOwnerNotifier("email", ({ text, subject }) => { got.email = { text, subject }; });

  const delivered = await notifyOwner("Reminder: trash night");

  assert.deepEqual(delivered.sort(), ["email", "slack"]);
  assert.equal(got.slack, "Reminder: trash night");
  assert.equal(got.email.text, "Reminder: trash night");
  assert.equal(got.email.subject, "Reminder: trash night"); // first line becomes the subject
});

test("a failing channel never blocks the others; only delivered channels are returned", async () => {
  const seen = [];
  registerOwnerNotifier("slack", () => { throw new Error("bluebubbles down"); });
  registerOwnerNotifier("email", ({ text }) => { seen.push(text); });

  const delivered = await notifyOwner("Security: new breach found");

  assert.deepEqual(delivered, ["email"]); // slack rejected, dropped from the result
  assert.deepEqual(seen, ["Security: new breach found"]);
});

test("explicit subject overrides the first-line default", async () => {
  let subj = null;
  registerOwnerNotifier("email", ({ subject }) => { subj = subject; });
  await notifyOwner("line one\nline two", { subject: "Cost alert" });
  assert.equal(subj, "Cost alert");
});

test("no live channels registered -> nothing delivered (no throw)", async () => {
  const delivered = await notifyOwner("into the void");
  assert.deepEqual(delivered, []);
});

test("awaits async channels before resolving", async () => {
  let done = false;
  registerOwnerNotifier("email", async () => {
    await new Promise((r) => setTimeout(r, 10));
    done = true;
  });
  const delivered = await notifyOwner("async please");
  assert.equal(done, true);
  assert.deepEqual(delivered, ["email"]);
});
