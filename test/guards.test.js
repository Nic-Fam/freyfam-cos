import { test } from "node:test";
import assert from "node:assert";
import { isAutomatedSender, isSelfAddress, shouldAutoReply, isWorkDomain, isFamilyAddress, isFamilySelfEmail, isAuthorizedSender, openChannelWarnings } from "../src/guards.js";

test("isFamilyAddress recognizes the family's own addresses (case-insensitive), not outsiders", () => {
  assert.equal(isFamilyAddress("Nic@Freyfam.com"), true);
  assert.equal(isFamilyAddress("shelli.frey@disney.com"), true);
  assert.equal(isFamilyAddress("nfrey2@gmail.com"), true);
  assert.equal(isFamilyAddress("julie@some-realty.com"), false);
  assert.equal(isFamilyAddress(""), false);
});

test("isFamilySelfEmail: all-family-personal recipients skip approval; work/outside do not", () => {
  // Every recipient a family personal inbox -> exempt (no approval)
  assert.equal(isFamilySelfEmail("nic@freyfam.com"), true);
  assert.equal(isFamilySelfEmail("Nic@Freyfam.com"), true); // case-insensitive
  assert.equal(isFamilySelfEmail("nic@freyfam.com, shelli@freyfam.com"), true); // comma list
  assert.equal(isFamilySelfEmail(["nic@freyfam.com", "nfrey2@gmail.com"]), true); // array
  // A work-domain family address still needs approval (constraint #1)
  assert.equal(isFamilySelfEmail("shelli.frey@disney.com"), false);
  assert.equal(isFamilySelfEmail("nicholas.frey@flyerdefense.com"), false);
  // Any outsider in the mix -> not exempt, even alongside a family address
  assert.equal(isFamilySelfEmail("julie@some-realty.com"), false);
  assert.equal(isFamilySelfEmail(["nic@freyfam.com", "julie@some-realty.com"]), false);
  assert.equal(isFamilySelfEmail(["nic@freyfam.com", "shelli.frey@disney.com"]), false);
  // Nothing to send -> not exempt
  assert.equal(isFamilySelfEmail(""), false);
  assert.equal(isFamilySelfEmail([]), false);
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

test("isAuthorizedSender: imessage/sms FAIL CLOSED when no allowlist is configured", () => {
  // Default env sets no IMESSAGE_ALLOW: every handle is refused (an Apple ID is
  // guessable, and an open gate let any sender approve a staged action).
  assert.equal(isAuthorizedSender({ channel: "imessage", from: "+15551234567" }), false);
  assert.equal(isAuthorizedSender({ channel: "sms", from: "+15551234567" }), false);
});

test("isAuthorizedSender: slack FAILS CLOSED when no allowlist is configured", () => {
  assert.equal(isAuthorizedSender({ channel: "slack", from: "U12345SLACK" }), false);
});

test("isAuthorizedSender: voice is trusted (token-gated upstream); unknown channels are not", () => {
  assert.equal(isAuthorizedSender({ channel: "voice", from: "x" }), true);
  assert.equal(isAuthorizedSender({ channel: undefined, from: "x" }), false);
  assert.equal(isAuthorizedSender({ channel: "webhook", from: "x" }), false);
  assert.equal(isAuthorizedSender({ channel: "voice", from: "" }), false);
});

test("openChannelWarnings names enabled channels that have no allowlist", () => {
  const w = openChannelWarnings({
    imessage: { enabled: true, allow: [] },
    slack: { enabled: true, allow: ["U1"] },
  });
  assert.equal(w.length, 1);
  assert.match(w[0], /^imessage/);
  assert.deepEqual(openChannelWarnings({ imessage: { enabled: false, allow: [] }, slack: { enabled: false, allow: [] } }), []);
});
