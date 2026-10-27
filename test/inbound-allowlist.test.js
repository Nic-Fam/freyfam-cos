import { test } from "node:test";
import assert from "node:assert";

// Positive side of the fail-closed allowlists: with IMESSAGE_ALLOW / SLACK_ALLOW
// set (before config.js loads), the listed senders are authorized and others are
// not. Runs in its own process (node --test isolates files), so the env is clean.
process.env.IMESSAGE_ALLOW = "+15551234567, nic@icloud.com";
process.env.SLACK_ALLOW = "U0NIC,U0SHELLI";
const { isAuthorizedSender } = await import("../src/guards.js");

test("iMessage/sms: listed handles pass (case-insensitive), others are refused", () => {
  assert.equal(isAuthorizedSender({ channel: "imessage", from: "+15551234567" }), true);
  assert.equal(isAuthorizedSender({ channel: "imessage", from: "Nic@iCloud.com" }), true);
  assert.equal(isAuthorizedSender({ channel: "sms", from: "+15551234567" }), true);
  assert.equal(isAuthorizedSender({ channel: "imessage", from: "+15550000000" }), false);
});

test("slack: listed user ids pass (case-sensitive), others are refused", () => {
  assert.equal(isAuthorizedSender({ channel: "slack", from: "U0NIC" }), true);
  assert.equal(isAuthorizedSender({ channel: "slack", from: "u0nic" }), false);
  assert.equal(isAuthorizedSender({ channel: "slack", from: "U0GUEST" }), false);
});
