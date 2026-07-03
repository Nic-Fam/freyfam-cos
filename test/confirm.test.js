import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-pending-approvals-test.json");
const RESOLVED = join(os.tmpdir(), "cos-pending-approvals-test-resolved.json");
process.env.PENDING_APPROVALS_PATH = TMP;
const { requestConfirmation, resolveByCode, tryResolveConfirmation, registerActionHandler } = await import("../src/confirm.js");

// A test executor: records the params it ran with, keyed by `kind`.
let ran;
registerActionHandler("test", async (params) => { ran.push(params); return `did: ${params.what}`; });
registerActionHandler("boom", async () => { throw new Error("kaboom"); });

const wipe = () => Promise.all([rm(TMP, { force: true }), rm(RESOLVED, { force: true })]);
beforeEach(async () => { ran = []; await wipe(); });
after(wipe);

test("requestConfirmation stages without executing and returns a code + instruction", async () => {
  const { code, instruction } = await requestConfirmation("do a thing", "test", { what: "x" });
  assert.match(code, /^[0-9A-F]{4}$/);
  assert.match(instruction, new RegExp(`YES ${code}`));
  assert.deepEqual(ran, [], "must not run until approved");
});

test("a duplicate YES for a just-handled code is reassured, not alarmed", async () => {
  const { code } = await requestConfirmation("create event X", "test", { what: "event" });
  await tryResolveConfirmation(`YES ${code}`); // first: runs it
  const dup = await tryResolveConfirmation(`YES ${code}`); // duplicate reply
  assert.equal(dup.handled, true);
  assert.match(dup.message, /already handled/i);
  assert.doesNotMatch(dup.message, /unknown or expired|forg|phish/i);
  assert.equal(ran.length, 1, "the action does NOT run a second time");
});

test("a truly unknown code gets a calm message, never an alarm", async () => {
  const res = await tryResolveConfirmation("YES 9a9a"); // valid 4-hex code, never staged
  assert.equal(res.handled, true);
  assert.doesNotMatch(res.message, /unknown or expired|forg|phish|attack/i);
  assert.match(res.message, /nothing to worry about/i);
});

test("YES runs the staged action with its params and returns the result", async () => {
  const { code } = await requestConfirmation("create event X", "test", { what: "event" });
  const res = await tryResolveConfirmation(`YES ${code}`);
  assert.equal(res.handled, true);
  assert.equal(res.message, "did: event");
  assert.deepEqual(ran, [{ what: "event" }]);
});

test("NO cancels without running", async () => {
  const { code } = await requestConfirmation("send mail", "test", { what: "y" });
  const res = await tryResolveConfirmation(`NO ${code}`);
  assert.match(res.message, /Cancelled/);
  assert.deepEqual(ran, []);
});

test("staged approvals PERSIST across a fresh module load (restart-safe)", async () => {
  const { code } = await requestConfirmation("survive a restart", "test", { what: "persisted" });
  // Re-import with a cache-busting query to simulate a brand-new process reading the file.
  const fresh = await import(`../src/confirm.js?reload=${code}`);
  fresh.registerActionHandler("test", async (params) => { ran.push(params); return `did: ${params.what}`; });
  const res = await fresh.tryResolveConfirmation(`YES ${code}`);
  assert.equal(res.message, "did: persisted");
  assert.deepEqual(ran, [{ what: "persisted" }]);
});

test("a code resolves only once", async () => {
  const { code } = await requestConfirmation("once", "test", { what: "z" });
  assert.equal((await resolveByCode(code, true)).found, true);
  assert.equal((await resolveByCode(code, true)).found, false);
});

test("an expired/unknown code is answered gracefully, NOT routed as a new message", async () => {
  // The bug behind Frank's freakout: a late/expired approval reply fell through to
  // normal routing. It must be handled with an "expired" note instead.
  const res = await tryResolveConfirmation("YES AB12"); // hex-shaped code, not pending
  assert.equal(res.handled, true);
  assert.match(res.message, /already handled or has expired/i); // calm, not alarmist
  assert.doesNotMatch(res.message, /forg|phish|attack/i);
});

test("non-approval text routes normally (handled:false)", async () => {
  assert.equal((await tryResolveConfirmation("what's on the calendar?")).handled, false);
  assert.equal((await tryResolveConfirmation("yes please book the dentist sometime")).handled, false); // no code token
});

test("tolerant matching: punctuation + extra words still approves", async () => {
  const { code } = await requestConfirmation("book it", "test", { what: "tol" });
  const res = await tryResolveConfirmation(`Yes, ${code} -- thanks!`);
  assert.equal(res.message, "did: tol");
});

test("tolerant matching: an email reply with a quoted thread still approves", async () => {
  const { code } = await requestConfirmation("book it", "test", { what: "email" });
  const body = `YES ${code}\n\nOn Mon, Jun 23, 2026 at 9:00 AM Lloyd wrote:\n> Approval needed: ...\n> Reply YES ${code}`;
  const res = await tryResolveConfirmation(body);
  assert.equal(res.message, "did: email");
});

test("a long prose message with an incidental yes + token is NOT treated as an approval", async () => {
  const { code } = await requestConfirmation("x", "test", { what: "noprose" });
  const long = `Yes I was thinking about the trip in ${code} and also a bunch of other plans `.repeat(4);
  assert.equal((await tryResolveConfirmation(long)).handled, false);
  assert.deepEqual(ran, []); // nothing executed
});

test("a failing action surfaces as an error message, not a throw", async () => {
  const { code } = await requestConfirmation("flaky", "boom", {});
  const res = await tryResolveConfirmation(`yes ${code}`);
  assert.match(res.message, /failed: kaboom/);
});

test("requestConfirmation rejects an unregistered kind", async () => {
  await assert.rejects(() => requestConfirmation("x", "nope", {}), /no action handler/);
});


registerActionHandler("email", async (p) => `sent to ${p.to}`);

test("flood guard: first NOTIFY_CAP(3) to a recipient ping; further ones stage silently (throttled)", async () => {
  const to = "nfrey2@gmail.com";
  const r = [];
  // 5 misfiring-loop warnings, varied subjects, same recipient+kind
  for (const s of ["Heads-up: Apple ID phishing", "URGENT: Apple ID attempt", "Action needed: Apple ID",
                   "Apple ID security alert", "Possible Apple ID access"]) {
    r.push(await requestConfirmation(s, "email", { to, subject: s }));
  }
  assert.deepEqual(r.map((x) => Boolean(x.throttled)), [false, false, false, true, true],
    "first 3 notify, 4th+ throttled");
  // EVERY action still staged (nothing dropped) — even a throttled one resolves
  const res = await tryResolveConfirmation(`YES ${r[4].code}`);
  assert.equal(res.handled, true, "throttled approval is still staged + resolvable");
});

test("a different recipient is counted separately (not throttled by another's flood)", async () => {
  const to1 = "a@x.com";
  for (let i = 0; i < 4; i++) await requestConfirmation("x"+i, "email", { to: to1, subject: "x"+i });
  const other = await requestConfirmation("real one", "email", { to: "b@y.com", subject: "Approve grocery order" });
  assert.notEqual(other.throttled, true);
});

test("kinds with no recipient never throttle (cap keys on recipient)", async () => {
  const out = [];
  for (let i = 0; i < 6; i++) out.push(await requestConfirmation("t"+i, "test", { what: "t"+i }));
  assert.ok(out.every((x) => !x.throttled));
});
