import { test } from "node:test";
import assert from "node:assert";
import { isBlockedIp, assertPublicUrl } from "../src/net-guard.js";

test("isBlockedIp flags loopback/private/link-local/CGNAT/multicast v4", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "172.31.255.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255"]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test("isBlockedIp allows public v4 and non-private 172.x", () => {
  for (const ip of ["93.184.216.34", "8.8.8.8", "172.15.0.1", "172.32.0.1"]) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test("isBlockedIp flags loopback/ULA/link-local v6 and IPv4-mapped privates", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false, "public v6 allowed");
});

test("assertPublicUrl rejects non-http(s) schemes", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /http/);
  await assert.rejects(() => assertPublicUrl("ftp://example.com/x"), /http/);
});

test("assertPublicUrl rejects literal private/loopback hosts and localhost names", async () => {
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1:8787/"), /private|loopback/i);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/"), /private|loopback|link-local/i);
  await assert.rejects(() => assertPublicUrl("http://localhost/x"), /loopback/i);
  await assert.rejects(() => assertPublicUrl("http://[::1]/"), /private|loopback/i);
});

test("assertPublicUrl allows a public literal IP and a public-resolving name", async () => {
  await assert.doesNotReject(() => assertPublicUrl("https://93.184.216.34/x"));
  await assert.doesNotReject(() =>
    assertPublicUrl("https://example.com/x", { resolve: async () => [{ address: "93.184.216.34" }] }));
});

test("assertPublicUrl rejects a name that resolves to a private address", async () => {
  await assert.rejects(
    () => assertPublicUrl("https://sneaky.example/x", { resolve: async () => [{ address: "192.168.1.10" }] }),
    /resolves to a private/i
  );
});

test("assertPublicUrl fails OPEN when resolution errors (cannot fetch it anyway)", async () => {
  await assert.doesNotReject(() =>
    assertPublicUrl("https://nope.invalid/x", { resolve: async () => { throw new Error("NXDOMAIN"); } }));
});

test("assertPublicUrl rejects an unparseable URL", async () => {
  await assert.rejects(() => assertPublicUrl("not a url"), /Invalid URL/);
});
