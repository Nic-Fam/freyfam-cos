import { test } from "node:test";
import assert from "node:assert";
import { authResultsVerdict, internalTenantVerdict, verifyEmailSender } from "../src/email-auth.js";

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

// Real shape of nic@ -> cos@ inside the tenant (2026-10-30): Exchange stamps no
// DMARC/compauth verdict, only its own X-MS-Exchange-* markers. Fake tenant id.
const TENANT = "00000000-1111-2222-3333-444444444444";
const EXO_INTERNAL_AR = "mx.microsoft.com 1; dkim=none (message not signed) header.d=none;dmarc=none action=none header.from=example.com;";
const INTERNAL = { authAs: ["Internal"], directionality: ["Originating"], crossTenantId: [TENANT] };
const internalMsg = (exchange) => async () => ({ authResults: [EXO_INTERNAL_AR], exchange });
const MSG = { from: "nic@freyfam.com", graphMessageId: "a" };

test("internalTenantVerdict: Internal + Originating + our tenant verifies (case-insensitive)", () => {
  assert.equal(internalTenantVerdict(INTERNAL, TENANT).verified, true);
  assert.equal(internalTenantVerdict({ authAs: "internal", directionality: " ORIGINATING ", crossTenantId: TENANT.toUpperCase() }, TENANT).verified, true);
});

test("internalTenantVerdict: wrong tenant, Anonymous, Incoming, conflicting duplicates, no tenant all fail", () => {
  assert.equal(internalTenantVerdict({ ...INTERNAL, crossTenantId: ["99999999-1111-2222-3333-444444444444"] }, TENANT).verified, false);
  assert.equal(internalTenantVerdict({ ...INTERNAL, authAs: ["Anonymous"] }, TENANT).verified, false);
  assert.equal(internalTenantVerdict({ ...INTERNAL, directionality: ["Incoming"] }, TENANT).verified, false);
  assert.equal(internalTenantVerdict({ ...INTERNAL, authAs: ["Internal", "Anonymous"] }, TENANT).verified, false);
  assert.equal(internalTenantVerdict(INTERNAL, "").verified, false);
  assert.equal(internalTenantVerdict(INTERNAL, undefined).verified, false);
  assert.equal(internalTenantVerdict(null, TENANT).verified, false);
  // The same value stamped twice is still one distinct value.
  assert.equal(internalTenantVerdict({ ...INTERNAL, authAs: ["Internal", "internal"] }, TENANT).verified, true);
});

test("verifyEmailSender: intra-tenant mail with dmarc=none verifies via the Exchange stamps", async () => {
  const v = await verifyEmailSender(MSG, { fetchHeader: internalMsg(INTERNAL), tenantId: TENANT });
  assert.equal(v.verified, true);
  assert.match(v.reason, /internal tenant/);
});

test("verifyEmailSender: dmarc=none plus non-internal stamps keeps the DMARC failure reason", async () => {
  const wrongTenant = await verifyEmailSender(MSG, { fetchHeader: internalMsg({ ...INTERNAL, crossTenantId: ["99999999-1111-2222-3333-444444444444"] }), tenantId: TENANT });
  assert.equal(wrongTenant.verified, false);
  assert.match(wrongTenant.reason, /dmarc=none/);
  const anonymous = await verifyEmailSender(MSG, { fetchHeader: internalMsg({ ...INTERNAL, authAs: ["Anonymous"] }), tenantId: TENANT });
  assert.equal(anonymous.verified, false);
  const incoming = await verifyEmailSender(MSG, { fetchHeader: internalMsg({ ...INTERNAL, directionality: ["Incoming"] }), tenantId: TENANT });
  assert.equal(incoming.verified, false);
  const noTenant = await verifyEmailSender(MSG, { fetchHeader: internalMsg(INTERNAL), tenantId: "" });
  assert.equal(noTenant.verified, false);
});

test("verifyEmailSender: object shape still honors dmarc=pass and still rejects a spoof", async () => {
  const pass = await verifyEmailSender(MSG, { fetchHeader: async () => ({ authResults: [EXO_PASS], exchange: {} }), tenantId: TENANT });
  assert.equal(pass.verified, true);
  assert.equal(pass.reason, "dmarc=pass");
  const spoof = await verifyEmailSender(MSG, { fetchHeader: async () => ({ authResults: [EXO_SPOOF], exchange: { authAs: ["Anonymous"], directionality: ["Incoming"], crossTenantId: [] } }), tenantId: TENANT });
  assert.equal(spoof.verified, false);
});

test("verifyEmailSender: legacy array shape still works (no Exchange stamps to fall back on)", async () => {
  assert.equal((await verifyEmailSender(MSG, { fetchHeader: async () => [EXO_PASS], tenantId: TENANT })).verified, true);
  assert.equal((await verifyEmailSender(MSG, { fetchHeader: async () => [EXO_INTERNAL_AR], tenantId: TENANT })).verified, false);
});
