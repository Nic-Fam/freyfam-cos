import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

// Isolate the package store + pending-approvals file so the carve-out runs fully
// local (no network): a suppressed sender returns before any triage/model call.
const PKG = join(os.tmpdir(), "cos-ship-pkgs.json");
const PEND = join(os.tmpdir(), "cos-ship-pending.json");
process.env.PACKAGES_PATH = PKG;
process.env.PENDING_APPROVALS_PATH = PEND;

const { handleInbound } = await import("../src/orchestrator.js");
const { listActivePackages } = await import("../src/packages.js");

const clean = () => Promise.all([rm(PKG, { force: true }), rm(PEND, { force: true })]);
beforeEach(clean);
after(clean);

function capturingTransport() {
  const t = { replies: [], reply: async (text) => void t.replies.push(text), mirror: async () => {} };
  return t;
}

test("a no-reply carrier shipping email is tracked silently (recorded, no reply sent)", async () => {
  const t = capturingTransport();
  await handleInbound(
    {
      channel: "email",
      from: "no-reply@ups.com", // automated sender -> auto-reply suppressed
      subject: "Shipped: your Amazon.com order",
      body: "Your package has shipped via UPS. Tracking: 1Z999AA10123456784. It is on its way.",
    },
    t
  );
  assert.equal(t.replies.length, 0, "must not auto-reply to a no-reply carrier");
  const pkgs = await listActivePackages();
  assert.equal(pkgs.length, 1, "the shipment was recorded instead of dropped");
  assert.equal(pkgs[0].trackingNumber, "1Z999AA10123456784");
  assert.equal(pkgs[0].carrier, "UPS");
});

test("a no-reply marketing email records nothing (no tracking number)", async () => {
  const t = capturingTransport();
  await handleInbound(
    { channel: "email", from: "newsletter@store.com", subject: "50% off this weekend!", body: "Shop our sale now." },
    t
  );
  assert.equal(t.replies.length, 0);
  assert.deepEqual(await listActivePackages(), []);
});
