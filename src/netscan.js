// Pure helpers for Frank's LAN scan (deploy/security/netscan.mjs).
//
// Frank's mini can sit on more than one network leg (the Asus main subnet on en0
// plus the Eero/IoT subnet on a USB Ethernet adapter), so the scan discovers every
// directly-attached IPv4 subnet instead of assuming en0's /24. Everything here is
// side-effect free so it can be unit tested without a network.

// Interfaces that are never a household LAN: loopback, VPN tunnels (Tailscale is a
// utun), Apple peer-to-peer links, Thunderbolt bridges.
const SKIP_IFACE = /^(lo|utun|gif|stf|awdl|llw|bridge|ap|ipsec|ppp)\d*/;

// Widest subnet we will sweep. Eero's default DHCP range is a /22 (1022 hosts);
// anything wider would be thousands of pings every 30 minutes, so we clamp to
// the /22 around our own address.
export const MIN_PREFIX = 22;

export const ipToInt = (ip) =>
  ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
export const intToIp = (n) =>
  [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** "0xffffff00" or "255.255.255.0" -> prefix length (24). */
export function maskToPrefix(mask) {
  const n = mask.startsWith("0x") ? parseInt(mask, 16) >>> 0 : ipToInt(mask);
  let bits = 0;
  for (let i = 31; i >= 0 && (n >>> i) & 1; i--) bits++;
  return bits;
}

/** Build a subnet record for an address on an interface. */
export function subnetFor(iface, ip, prefix) {
  const p = Math.max(prefix, MIN_PREFIX);
  const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  const network = (ipToInt(ip) & mask) >>> 0;
  return {
    iface,
    self: ip,
    prefix: p,
    clamped: p !== prefix,
    network: intToIp(network),
    cidr: `${intToIp(network)}/${p}`,
  };
}

/**
 * Parse macOS `ifconfig` output into the LAN subnets worth scanning.
 * Skips tunnels/loopback, link-local (169.254/16), Tailscale CGNAT (100.64/10),
 * and point-to-point /32s. `only` (e.g. ["en0","en7"]) restricts to named ifaces.
 */
export function parseIfconfig(text, only = null) {
  const out = [];
  let iface = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^([a-z][a-z0-9]*):\s/i);
    if (head) { iface = head[1]; continue; }
    const m = line.match(/^\s+inet (\d+\.\d+\.\d+\.\d+)(?: --> \S+)? netmask (\S+)/);
    if (!m || !iface) continue;
    if (only ? !only.includes(iface) : SKIP_IFACE.test(iface)) continue;
    const [, ip, mask] = m;
    if (ip.startsWith("127.") || ip.startsWith("169.254.")) continue;
    const n = ipToInt(ip);
    if (n >= ipToInt("100.64.0.0") && n <= ipToInt("100.127.255.255")) continue; // Tailscale/CGNAT
    const prefix = maskToPrefix(mask);
    if (prefix >= 31) continue;
    const s = subnetFor(iface, ip, prefix);
    if (!out.some((o) => o.cidr === s.cidr)) out.push(s);
  }
  return out;
}

/** True if ip falls inside the subnet record. */
export function inSubnet(ip, subnet) {
  const mask = (0xffffffff << (32 - subnet.prefix)) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ipToInt(subnet.network);
}

/** Every usable host address in the subnet (excludes network + broadcast). */
export function hostsOf(subnet) {
  const size = 2 ** (32 - subnet.prefix);
  const base = ipToInt(subnet.network);
  const hosts = [];
  for (let i = 1; i < size - 1; i++) hosts.push(intToIp(base + i));
  return hosts;
}

/** Pad each MAC octet to 2 hex digits + lowercase, so 0:1f:54 == 00:1f:54. */
export function normMac(mac) {
  return mac.split(":").map((o) => o.padStart(2, "0").toLowerCase()).join(":");
}

/**
 * Parse `arp -an` / `arp -a` output into devices inside the given subnets.
 * Each device carries the subnet CIDR it was seen on. De-duped by MAC.
 */
export function parseArp(text, subnets, ouiOf = () => "unknown") {
  const devices = [];
  const seen = new Set();
  for (const line of text.split("\n")) {
    // host (ip) at mac on en0 ifscope [ethernet]
    const m = line.match(/^(\S+) \(([\d.]+)\) at ([0-9a-fA-F:]+) on/);
    if (!m || /incomplete/i.test(line)) continue;
    const [, host, ip, rawMac] = m;
    if (!rawMac.includes(":")) continue;
    const subnet = subnets.find((s) => inSubnet(ip, s));
    if (!subnet) continue;
    const mac = normMac(rawMac);
    if (mac === "ff:ff:ff:ff:ff:ff" || seen.has(mac)) continue;
    seen.add(mac);
    devices.push({ mac, ip, host: host === "?" ? "" : host, vendor: ouiOf(mac), subnet: subnet.cidr });
  }
  return devices;
}

/**
 * Diff the live scan against the baseline. "gone" only covers baseline devices
 * whose IP sits in a subnet we actually scanned, so unplugging the IoT adapter
 * doesn't report every IoT device as missing.
 */
export function diffScan(baseline, current, subnets) {
  const base = new Map(baseline.map((d) => [d.mac, d]));
  const cur = new Map(current.map((d) => [d.mac, d]));
  const scanned = (ip) => subnets.some((s) => inSubnet(ip, s));
  return {
    added: current.filter((d) => !base.has(d.mac)),
    gone: baseline.filter((d) => !cur.has(d.mac) && d.ip && scanned(d.ip)),
    movedIp: current
      .filter((d) => base.has(d.mac) && base.get(d.mac).ip !== d.ip)
      .map((d) => ({ ...d, wasIp: base.get(d.mac).ip })),
  };
}

/**
 * Merge a scan into the baseline for --save. Seen devices are written with their
 * current IP/host (keeping human notes); baselined devices NOT seen this run are
 * KEPT, because being offline (a phone away, a sleeping battery camera, the IoT
 * adapter unplugged) doesn't make a trusted device untrusted.
 */
export function mergeBaseline(baseline, current) {
  const old = new Map((baseline || []).map((d) => [d.mac, d]));
  const seen = new Set(current.map((d) => d.mac));
  const merged = current.map((d) => {
    const prev = old.get(d.mac) || {};
    return { mac: d.mac, ip: d.ip, host: d.host || prev.host || "", vendor: d.vendor, subnet: d.subnet, note: prev.note || "" };
  });
  for (const d of baseline || []) if (!seen.has(d.mac)) merged.push(d);
  return merged;
}

/** Run async jobs with a concurrency cap (a /22 is 1022 pings). */
export async function pool(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
