import { test } from "node:test";
import assert from "node:assert";
import { signalsFingerprint } from "../src/triage.js";

const mail = (from, subject, receivedAt) => ({ from, subject, receivedAt, fromFamily: false });
const kitchen = (item, expiresAt, daysUntil) => ({ source: "kitchen", item, expiresAt, daysUntil });

test("empty signal sets share one stable fingerprint", () => {
  assert.equal(signalsFingerprint([]), "empty");
  assert.equal(signalsFingerprint(undefined), "empty");
  assert.equal(signalsFingerprint([]), signalsFingerprint([]));
});

test("identical signal sets fingerprint identically (gate skips the tick)", () => {
  const a = [mail("a@x.com", "Hi", "2026-06-30T10:00:00Z"), kitchen("milk", "2026-07-02", 2)];
  const b = [mail("a@x.com", "Hi", "2026-06-30T10:00:00Z"), kitchen("milk", "2026-07-02", 2)];
  assert.equal(signalsFingerprint(a), signalsFingerprint(b));
});

test("order does not matter (a reshuffled set is still 'unchanged')", () => {
  const m = mail("a@x.com", "Hi", "2026-06-30T10:00:00Z");
  const k = kitchen("milk", "2026-07-02", 2);
  assert.equal(signalsFingerprint([m, k]), signalsFingerprint([k, m]));
});

test("a new mail changes the fingerprint (gate triages)", () => {
  const base = [mail("a@x.com", "Hi", "2026-06-30T10:00:00Z")];
  const withNew = [...base, mail("b@y.com", "New", "2026-06-30T10:30:00Z")];
  assert.notEqual(signalsFingerprint(base), signalsFingerprint(withNew));
});

test("daysUntil ticking down does NOT change the fingerprint (same item, later tick)", () => {
  // Same milk, one day closer to expiry: identity (item+expiresAt) is unchanged,
  // so the gate must still treat it as 'nothing new' and skip the Haiku call.
  const today = [kitchen("milk", "2026-07-02", 2)];
  const tomorrow = [kitchen("milk", "2026-07-02", 1)];
  assert.equal(signalsFingerprint(today), signalsFingerprint(tomorrow));
});

test("a genuinely new expiring item changes the fingerprint", () => {
  const a = [kitchen("milk", "2026-07-02", 2)];
  const b = [kitchen("milk", "2026-07-02", 2), kitchen("eggs", "2026-07-01", 1)];
  assert.notEqual(signalsFingerprint(a), signalsFingerprint(b));
});

test("prefers a stable id when present", () => {
  const a = [{ id: "AAMk-123", from: "a@x.com", subject: "Hi" }];
  const b = [{ id: "AAMk-123", from: "different@z.com", subject: "Changed subject" }];
  // Same id => same message => unchanged, regardless of other fields.
  assert.equal(signalsFingerprint(a), signalsFingerprint(b));
});
