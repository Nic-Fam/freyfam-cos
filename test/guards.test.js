import { test } from "node:test";
import assert from "node:assert";
import { isAutomatedSender, isSelfAddress, shouldAutoReply, isWorkDomain, isFamilyAddress, isAuthorizedSender } from "../src/guards.js";

test("isFamilyAddress recognizes the family's own addresses (case-insensitive), not outsiders", () => {
  assert.equal(isFamilyAddress("Nic@Freyfam.com"), true);
  assert.equal(isFamilyAddress("shelli.frey@disney.com"), true);
  assert.equal(isFamilyAddress("nfrey2@gmail.com"), true);
  assert.equal(isFamilyAddress("julie@some-realty.com"), false);
  assert.equal(isFamilyAddress(""), false);
});

test("isAutomatedSender flags bounce/no-reply/notification/marketing senders", () => {
  for (const a of [
    "MAILER-DAEMON@amazon.com",
    "order-update@amazon.com",
    "shipment-tracking@amazon.com",
    "no-reply@some.com",
    "notifications@github.com",
    "m365copilotupdates@microsoft.com", // 'updates' token
    "nordstrom@marketing.email.nordstrom.com", // bulk subdomain
    "nordstrom@eml.nordstrom.com",
  ]) {
    assert.equal(isAutomatedSender(a), true, `${a} should be automated`);
  }
});

test("isAutomatedSender leaves real humans and non-email senders alone", () => {
  for (const a of ["Nic@Freyfam.com", "grandma@gmail.com", "+15551234567", "U12345SLACK", ""]) {
    assert.equal(isAutomatedSender(a), false, `${a} should NOT be automated`);
  }
});

test("isSelfAddress catches the mailbox and the assistant@ alias (case-insensitive)", () => {
  assert.equal(isSelfAddress("cos@freyfam.com"), true);
  assert.equal(isSelfAddress("COS@Freyfam.com"), true);
  assert.equal(isSelfAddress("assistant@freyfam.com"), true);
  assert.equal(isSelfAddress("Nic@Freyfam.com"), false);
});

test("shouldAutoReply: humans/SMS reply; bounces, bulk, and self are suppressed", () => {
  assert.equal(shouldAutoReply("Nic@Freyfam.com"), true);
  assert.equal(shouldAutoReply("+15551234567"), true);
  assert.equal(shouldAutoReply("MAILER-DAEMON@amazon.com"), false);
  assert.equal(shouldAutoReply("nordstrom@marketing.email.nordstrom.com"), false);
  assert.equal(shouldAutoReply("cos@freyfam.com"), false);
});

test("isWorkDomain still classifies configured work domains", () => {
  assert.equal(isWorkDomain("someone@flyerdefense.com"), true);
  assert.equal(isWorkDomain("someone@disney.com"), true);
  assert.equal(isWorkDomain("Nic@Freyfam.com"), false);
});

test("isAuthorizedSender: email is family-only (public mailbox is strict)", () => {
  assert.equal(isAuthorizedSender({ channel: "email", from: "Nic@Freyfam.com" }), true);
  assert.equal(isAuthorizedSender({ channel: "email", from: "shelli.frey@disney.com" }), true);
  // A human stranger who emails the public mailbox must NOT drive the chief.
  assert.equal(isAuthorizedSender({ channel: "email", from: "attacker@evil.com" }), false);
  assert.equal(isAuthorizedSender({ channel: "email", from: "" }), false);
});

test("isAuthorizedSender: imessage/sms open when no allowlist configured", () => {
  // Default env sets no IMESSAGE_ALLOW, so the private handle/number is the gate.
  assert.equal(isAuthorizedSender({ channel: "imessage", from: "+15551234567" }), true);
  assert.equal(isAuthorizedSender({ channel: "sms", from: "+15551234567" }), true);
});

test("isAuthorizedSender: slack open when no allowlist configured", () => {
  assert.equal(isAuthorizedSender({ channel: "slack", from: "U12345SLACK" }), true);
});

test("isAuthorizedSender: unknown/internal channels are trusted", () => {
  assert.equal(isAuthorizedSender({ channel: "voice", from: "x" }), true);
  assert.equal(isAuthorizedSender({ channel: undefined, from: "x" }), true);
});
