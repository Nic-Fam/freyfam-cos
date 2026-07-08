import { test } from "node:test";
import assert from "node:assert";
import { currentUplink, classifyUplink, uplinkStatus } from "../src/uplink.js";

const jsonRes = (obj) => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) });
const fetchReturning = (obj) => async () => jsonRes(obj);

test("classifyUplink: AT&T fiber is primary, not backup", () => {
  const c = classifyUplink({ ip: "76.246.77.56", asn: "AS7018", org: "AS7018 AT&T Enterprises, LLC", ok: true });
  assert.equal(c.onStarlink, false);
  assert.equal(c.onBackup, false);
});

test("classifyUplink: Starlink ASN is backup", () => {
  const c = classifyUplink({ ip: "98.97.0.1", asn: "AS14593", org: "AS14593 SpaceX Starlink", ok: true });
  assert.equal(c.onStarlink, true);
  assert.equal(c.onBackup, true);
});

test("classifyUplink: Starlink detected by org text even without a matched ASN", () => {
  const c = classifyUplink({ ip: "98.97.0.1", asn: "", org: "SpaceX Services, Inc.", ok: true });
  assert.equal(c.onStarlink, true);
});

test("classifyUplink: a third, unknown ASN counts as off-primary (backup)", () => {
  const c = classifyUplink({ ip: "1.2.3.4", asn: "AS99999", org: "AS99999 Some Other ISP", ok: true }, { primaryAsn: "AS7018" });
  assert.equal(c.onStarlink, false);
  assert.equal(c.onBackup, true, "not on the known primary -> treated as backup");
});

test("currentUplink parses ip/asn/org from ipinfo", async () => {
  const info = await currentUplink({ fetchImpl: fetchReturning({ ip: "76.246.77.56", org: "AS7018 AT&T Enterprises, LLC" }) });
  assert.equal(info.ip, "76.246.77.56");
  assert.equal(info.asn, "AS7018");
  assert.equal(info.ok, true);
});

test("currentUplink returns ok:false when the primary check errors and fallback fails", async () => {
  const info = await currentUplink({ fetchImpl: async () => ({ ok: false }) });
  assert.equal(info.ok, false);
});

test("uplinkStatus summary flags the Starlink backup with the activate hint", async () => {
  const s = await uplinkStatus({ fetchImpl: fetchReturning({ ip: "98.97.0.1", org: "AS14593 SpaceX Starlink" }) });
  assert.equal(s.onStarlink, true);
  assert.match(s.summary, /STARLINK backup/);
  assert.match(s.summary, /activate full Starlink/i);
});

test("uplinkStatus summary is calm when on the primary fiber", async () => {
  const s = await uplinkStatus({ fetchImpl: fetchReturning({ ip: "76.246.77.56", org: "AS7018 AT&T Enterprises, LLC" }) });
  assert.equal(s.onBackup, false);
  assert.match(s.summary, /Uplink normal/);
});
