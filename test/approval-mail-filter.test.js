import { test } from "node:test";
import assert from "node:assert";
import { isApprovalMechanismMail } from "../src/channels/graph.js";

test("isApprovalMechanismMail flags our own approval traffic (never a proactive signal)", () => {
  assert.equal(isApprovalMechanismMail("Approval needed (B075)"), true);
  assert.equal(isApprovalMechanismMail("Approve B075"), true);   // mailto Approve button
  assert.equal(isApprovalMechanismMail("Deny 6c52"), true);
  assert.equal(isApprovalMechanismMail("YES B075"), true);
  assert.equal(isApprovalMechanismMail("NO b075 cancel"), true);
});

test("isApprovalMechanismMail leaves real family/vendor mail alone", () => {
  assert.equal(isApprovalMechanismMail("Re: Fairview tour availability"), false);
  assert.equal(isApprovalMechanismMail("Your Amazon order has shipped"), false);
  assert.equal(isApprovalMechanismMail("Yes we can do Tuesday"), false); // "yes" without a 4-hex code
  assert.equal(isApprovalMechanismMail(""), false);
});
