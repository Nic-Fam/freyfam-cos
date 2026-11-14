import { test } from "node:test";
import assert from "node:assert";
import {
  maskToPrefix, parseIfconfig, inSubnet, hostsOf, parseArp, diffScan, mergeBaseline, subnetFor,
} from "../src/netscan.js";

// Trimmed real `ifconfig` from Frank's mini, plus a USB Ethernet adapter (en7) on
// an Eero /22 and a Tailscale utun that must be ignored.
const IFCONFIG = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.50.117 netmask 0xffffff00 broadcast 192.168.50.255
en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 192.168.5.20 netmask 0xfffffc00 broadcast 192.168.7.255
en8: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tinet 169.254.10.3 netmask 0xffff0000 broadcast 169.254.255.255
bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
utun5: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 100.76.87.54 --> 100.76.87.54 netmask 0xffffffff
`;

test("maskToPrefix handles hex and dotted masks", () => {
  assert.equal(maskToPrefix("0xffffff00"), 24);
  assert.equal(maskToPrefix("0xfffffc00"), 22);
  assert.equal(maskToPrefix("255.255.255.0"), 24);
});

test("parseIfconfig finds both LAN legs and skips loopback, link-local, Tailscale", () => {
  const subs = parseIfconfig(IFCONFIG);
  assert.deepEqual(subs.map((s) => [s.iface, s.cidr]), [
    ["en0", "192.168.50.0/24"],
    ["en7", "192.168.4.0/22"],
  ]);
});

test("parseIfconfig honors an explicit interface list", () => {
  assert.deepEqual(parseIfconfig(IFCONFIG, ["en7"]).map((s) => s.iface), ["en7"]);
});

test("subnets wider than /22 are clamped around our own address", () => {
  const s = subnetFor("en0", "10.0.42.9", 16);
  assert.equal(s.cidr, "10.0.40.0/22");
  assert.equal(s.clamped, true);
});

test("hostsOf and inSubnet cover a /22 correctly", () => {
  const eero = subnetFor("en7", "192.168.5.20", 22);
  const hosts = hostsOf(eero);
  assert.equal(hosts.length, 1022);
  assert.equal(hosts[0], "192.168.4.1");
  assert.equal(hosts.at(-1), "192.168.7.254");
  assert.ok(inSubnet("192.168.7.100", eero));
  assert.ok(!inSubnet("192.168.50.1", eero));
});

test("parseArp tags each device with its subnet and drops off-subnet/incomplete entries", () => {
  const subs = parseIfconfig(IFCONFIG);
  const arp = [
    "rt-be92u (192.168.50.1) at 60:cf:84:20:9d:d0 on en0 ifscope [ethernet]",
    "ring-cam (192.168.6.14) at 40:89:c6:1:2:3 on en7 ifscope [ethernet]",
    "? (192.168.6.99) at (incomplete) on en7 ifscope [ethernet]",
    "? (100.76.87.1) at 1:2:3:4:5:6 on utun5 [ethernet]",
    "? (192.168.50.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]",
  ].join("\n");
  const devs = parseArp(arp, subs);
  assert.deepEqual(devs.map((d) => [d.ip, d.mac, d.subnet]), [
    ["192.168.50.1", "60:cf:84:20:9d:d0", "192.168.50.0/24"],
    ["192.168.6.14", "40:89:c6:01:02:03", "192.168.4.0/22"],
  ]);
});

test("diffScan only reports GONE for subnets that were scanned", () => {
  const mainOnly = [subnetFor("en0", "192.168.50.117", 24)];
  const baseline = [
    { mac: "aa", ip: "192.168.50.10" },
    { mac: "bb", ip: "192.168.6.14" }, // IoT leg, adapter unplugged this run
  ];
  const { gone, added } = diffScan(baseline, [{ mac: "cc", ip: "192.168.50.11" }], mainOnly);
  assert.deepEqual(gone.map((d) => d.mac), ["aa"]);
  assert.deepEqual(added.map((d) => d.mac), ["cc"]);
});

test("mergeBaseline keeps offline trusted devices and their notes", () => {
  const baseline = [
    { mac: "aa", ip: "192.168.50.63", host: "iphone", vendor: "Apple", note: "Nic's iPhone" },
    { mac: "bb", ip: "192.168.50.10", host: "", vendor: "x", note: "printer" },
  ];
  const current = [{ mac: "bb", ip: "192.168.50.12", host: "lexmark", vendor: "Lexmark", subnet: "192.168.50.0/24" }];
  const merged = mergeBaseline(baseline, current);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.find((d) => d.mac === "bb"), {
    mac: "bb", ip: "192.168.50.12", host: "lexmark", vendor: "Lexmark", subnet: "192.168.50.0/24", note: "printer",
  });
  assert.equal(merged.find((d) => d.mac === "aa").note, "Nic's iPhone");
});
