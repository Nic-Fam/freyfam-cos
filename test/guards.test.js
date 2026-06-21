import { test } from "node:test";
import assert from "node:assert";
import { isAutomatedSender, isSelfAddress, shouldAutoReply, isWorkDomain } from "../src/guards.js";

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
