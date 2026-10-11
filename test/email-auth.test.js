import { test } from "node:test";
import assert from "node:assert";
import { authResultsVerdict, verifyEmailSender } from "../src/email-auth.js";

const EXO_PASS =
  "spf=pass (sender IP is 209.85.220.41) smtp.mailfrom=gmail.com; dkim=pass (signature was verified) header.d=gmail.com; dmarc=pass action=none header.from=gmail.com; compauth=pass reason=100";
const EXO_SPOOF =
  "spf=fail (sender IP is 203.0.113.9) smtp.mailfrom=evil.example; dkim=none (message not signed) header.d=none; dmarc=fail action=none header.from=gmail.com; compauth=fail reason=001";
const EXO_INTRA_TENANT = "spf=none; dkim=none; dmarc=none; compauth=pass reason=109";
const EXO_SOFT = "spf=softfail (sender IP is 1.2.3.4) smtp.mailfrom=gmail.com; dkim=none; dmarc=none action=none header.from=gmail.com; compauth=none reason=405";

test("authResultsVerdict: dmarc=pass verifies", () => {
  const v = authResultsVerdict(EXO_PASS);
  assert.equal(v.verified, true);
  assert.equal(v.reason, "dmarc=pass");
  assert.equal(v.dkim, "pass");
});

test("authResultsVerdict: a spoof (dmarc=fail, compauth=fail) does NOT verify", () => {
  const v = authResultsVerdict(EXO_SPOOF);
  assert.equal(v.verified, false);
  assert.match(v.reason, /dmarc=fail/);
});

test("authResultsVerdict: intra-tenant mail with compauth=pass and no DKIM verifies", () => {
  assert.equal(authResultsVerdict(EXO_INTRA_TENANT).verified, true);
});

test("authResultsVerdict: softfail / none everywhere does not verify", () => {
  assert.equal(authResultsVerdict(EXO_SOFT).verified, false);
});

test("authResultsVerdict: missing header does not verify; arrays and case are tolerated", () => {
  assert.equal(authResultsVerdict(null).verified, false);
  assert.equal(authResultsVerdict("").verified, false);
  assert.equal(authResultsVerdict([]).verified, false);
  assert.equal(authResultsVerdict([EXO_PASS.toUpperCase()]).verified, true);
  // Several headers: the FIRST (the receiving hop's, top-most) verdict wins; a
  // pass stamped by an earlier relay cannot rescue a failing final hop.
  assert.equal(authResultsVerdict([EXO_SPOOF, EXO_INTRA_TENANT]).verified, false);
  assert.equal(authResultsVerdict([EXO_INTRA_TENANT, EXO_SPOOF]).verified, true);
});

test("authResultsVerdict: 'dmarc=pass' inside an unrelated token is not matched", () => {
  // e.g. a comment "(not dmarc=pass)" must still require the real key=value token boundary.
  assert.equal(authResultsVerdict("x-dmarc=pass; compauth=fail").verified, false);
});

test("verifyEmailSender fails closed: no id, no fetcher, fetch error, bad verdict", async () => {
  assert.equal((await verifyEmailSender({ from: "nic@freyfam.com" }, { fetchHeader: async () => [EXO_PASS] })).verified, false);
  assert.equal((await verifyEmailSender({ from: "nic@freyfam.com", graphMessageId: "a" }, {})).verified, false);
  assert.equal((await verifyEmailSender({ from: "nic@freyfam.com", graphMessageId: "a" }, { fetchHeader: async () => { throw new Error("x"); } })).verified, false);
  assert.equal((await verifyEmailSender({ from: "nic@freyfam.com", graphMessageId: "a" }, { fetchHeader: async () => [EXO_SPOOF] })).verified, false);
  const ok = await verifyEmailSender({ from: "nic@freyfam.com", graphMessageId: "a" }, { fetchHeader: async () => [EXO_PASS] });
  assert.equal(ok.verified, true);
  assert.equal(ok.enforced, true);
});
