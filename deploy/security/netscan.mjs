#!/usr/bin/env node
// Frank's repeatable LAN device scan + baseline diff.
//
// Scans the local /24 (ping sweep -> ARP table), then compares the live set of
// devices against a saved baseline and reports what is NEW, what is GONE, and
// which known devices changed IP. Identity is keyed by MAC (stable across DHCP),
// not IP. Offline-only: no external calls, OUI vendor from a small local map.
//
// Usage:
//   node deploy/security/netscan.mjs              # scan + diff against baseline
//   node deploy/security/netscan.mjs --save       # scan, then overwrite baseline
//                                                 # with the current set (keeps notes)
//   node deploy/security/netscan.mjs --json       # machine-readable diff to stdout
//
// Baseline lives at data/network-baseline.json (gitignored via data/*), so MACs
// never hit git. Frank can only see his own subnet; the Eero/IoT and camera
// subnets are separate legs off the Asus router and need their own scan host.
//
// Scope note: ping-silent devices won't populate ARP unless they talk to this
// box, so treat "GONE" as "not seen this run", not proof of removal.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { addFinding, listFindings } from "../../src/security.js";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const BASELINE = join(here, "..", "..", "data", "network-baseline.json");

// Known household OUIs (first 3 MAC octets, lowercase). Extend as devices are
// identified. Anything unmatched prints "unknown" -> a prompt to look it up.
const OUI = {
  "60:cf:84": "ASUSTek",   // core Asus RT-BE92U router
  "c8:7f:54": "ASUSTek",   // Asus device (AiMesh node / spare Merlin router)
  "14:9d:99": "Apple",     // the Mac minis (Lloyd, Frank)
  "00:1f:54": "Lorex",     // camera NVR
  "40:89:c6": "Amazon",    // Echo/Alexa/Fire/Ring
  "a8:b0:88": "eero",      // Eero mesh node
  "88:de:7c": "Askey",     // AT&T fiber gateway/CPE
  "00:90:a9": "WD",        // Western Digital My Book Live NAS (EOL - watch)
  "00:20:00": "Lexmark",   // printer
  "9c:ad:ef": "Obihai",    // OBi200 VoIP ATA
};

const args = new Set(process.argv.slice(2));
const SAVE = args.has("--save");
const JSON_OUT = args.has("--json");
// --record-findings: log each NEW device (vs baseline) as a security finding in
// Frank's local store, so Lloyd surfaces it on the next posture check. Read-only
// advisory (no control action), matching Frank's hard constraint. This is what the
// scheduled launchd job runs; NOT --save (auto-saving would absorb new devices into
// the baseline and never alert). addFinding dedups still-open findings, and we also
// skip any MAC that already has an open finding, so re-runs never spam.
const RECORD = args.has("--record-findings");

/** Pad each MAC octet to 2 hex digits + lowercase, so 0:1f:54 == 00:1f:54. */
function normMac(mac) {
  return mac
    .split(":")
    .map((o) => o.padStart(2, "0").toLowerCase())
    .join(":");
}
const ouiOf = (mac) => OUI[mac.split(":").slice(0, 3).join(":")] || "unknown";

// Locally-administered ("private Wi-Fi" / randomized) MAC: the 0x02 bit is set in
// the first octet. Phones and laptops rotate these for privacy, so they can't be
// stably baselined and would otherwise generate a perpetual stream of false "new
// device" findings. We still LIST them in a scan, but skip recording findings.
const isRandomMac = (mac) => (parseInt(mac.split(":")[0], 16) & 0x02) !== 0;

async function localPrefix() {
  // e.g. 192.168.50.117 -> "192.168.50"
  const { stdout } = await exec("ipconfig", ["getifaddr", "en0"]).catch(() => ({ stdout: "" }));
  const ip = stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("could not determine local IPv4 on en0");
  return { prefix: ip.split(".").slice(0, 3).join("."), self: ip };
}

async function pingSweep(prefix) {
  // Fire all 254 pings in parallel; we don't care about replies, only that the
  // ARP cache gets populated for hosts that answer at L2.
  const jobs = [];
  for (let i = 1; i <= 254; i++) {
    jobs.push(exec("ping", ["-c1", "-W300", `${prefix}.${i}`]).catch(() => {}));
  }
  await Promise.all(jobs);
}

async function readArp(prefix) {
  const { stdout } = await exec("arp", ["-a"]).catch(() => ({ stdout: "" }));
  const devices = [];
  for (const line of stdout.split("\n")) {
    // host (ip) at mac on en0 ifscope [ethernet]
    const m = line.match(/^(\S+) \(([\d.]+)\) at ([0-9a-fA-F:]+) on/);
    if (!m) continue;
    const [, host, ip, rawMac] = m;
    if (!ip.startsWith(prefix + ".")) continue;
    if (/incomplete/i.test(line)) continue;
    if (!rawMac.includes(":")) continue;
    const mac = normMac(rawMac);
    devices.push({ mac, ip, host: host === "?" ? "" : host, vendor: ouiOf(mac) });
  }
  // de-dupe by mac (keep first)
  const seen = new Set();
  return devices.filter((d) => (seen.has(d.mac) ? false : seen.add(d.mac)));
}

async function loadBaseline() {
  try {
    const raw = JSON.parse(await readFile(BASELINE, "utf8"));
    return Array.isArray(raw) ? raw : raw.devices || [];
  } catch {
    return null; // no baseline yet
  }
}

function diff(baseline, current) {
  const byMac = (arr) => new Map(arr.map((d) => [d.mac, d]));
  const base = byMac(baseline);
  const cur = byMac(current);
  const added = current.filter((d) => !base.has(d.mac));
  const gone = baseline.filter((d) => !cur.has(d.mac));
  const movedIp = current
    .filter((d) => base.has(d.mac) && base.get(d.mac).ip !== d.ip)
    .map((d) => ({ ...d, wasIp: base.get(d.mac).ip }));
  return { added, gone, movedIp };
}

function fmt(d) {
  const note = d.note ? `  — ${d.note}` : "";
  return `${d.ip.padEnd(15)} ${d.mac}  ${d.vendor.padEnd(10)} ${d.host || "(no name)"}${note}`;
}

const { prefix, self } = await localPrefix();
await pingSweep(prefix);
const current = (await readArp(prefix)).sort(
  (a, b) => Number(a.ip.split(".")[3]) - Number(b.ip.split(".")[3])
);
const baseline = await loadBaseline();

if (JSON_OUT) {
  const d = baseline ? diff(baseline, current) : { added: current, gone: [], movedIp: [] };
  console.log(JSON.stringify({ prefix, self, current, ...d }, null, 2));
} else {
  console.log(`\nScan of ${prefix}.0/24 from ${self} — ${current.length} host(s) seen\n`);
  for (const d of current) console.log("  " + fmt(d));

  if (!baseline) {
    console.log(`\nNo baseline yet. Run with --save to write one to data/network-baseline.json`);
  } else {
    const { added, gone, movedIp } = diff(baseline, current);
    console.log("\n--- diff vs baseline ---");
    if (!added.length && !gone.length && !movedIp.length) {
      console.log("  no changes; everything matches the baseline");
    }
    for (const d of added) console.log("  [NEW]      " + fmt(d));
    for (const d of gone) console.log("  [GONE]     " + fmt(d) + "  (not seen this run)");
    for (const d of movedIp) console.log(`  [IP CHG]   ${d.mac} ${d.host || ""}: ${d.wasIp} -> ${d.ip}`);
    if (added.length) console.log(`\n  ${added.length} new device(s) — identify before trusting.`);
  }
}

if (RECORD && baseline) {
  const { added } = diff(baseline, current);
  // Skip MACs that already have an open finding, so a device that lingers across
  // many scans isn't re-logged every run (addFinding also dedups as a backstop).
  const open = (await listFindings()).filter((f) => f && f.status === "open");
  const alreadyFlagged = (mac) => open.some((f) => (f.summary || "").toLowerCase().includes(mac));
  let logged = 0;
  let skippedRandom = 0;
  for (const d of added) {
    // Private-Wi-Fi / randomized MACs rotate, so they can't be baselined and would
    // flag forever. They're personal devices (phones/laptops), not the threat model.
    if (isRandomMac(d.mac)) { skippedRandom++; continue; }
    if (alreadyFlagged(d.mac)) continue;
    await addFinding({
      title: `New device on LAN: ${d.host || "unknown"} ${d.ip} [${d.mac}]`,
      severity: "medium",
      summary: `Unrecognized device on ${prefix}.0/24 seen by Frank's scheduled scan: ${d.ip} MAC ${d.mac} vendor ${d.vendor}, hostname "${d.host || "(none)"}". Not in the network baseline.`,
      recommendation: `Confirm it's expected. If yes, add to baseline: node deploy/security/netscan.mjs --save. If unknown, investigate and consider isolating it on the IoT/guest subnet.`,
    });
    logged++;
  }
  if (!JSON_OUT) console.log(`\nRecorded ${logged} new-device finding(s) to Frank's security store.${skippedRandom ? ` Skipped ${skippedRandom} randomized-MAC (personal) device(s).` : ""}`);
}

if (SAVE) {
  // Preserve human-added notes/identity from the old baseline by MAC.
  const oldByMac = new Map((baseline || []).map((d) => [d.mac, d]));
  const merged = current.map((d) => {
    const prev = oldByMac.get(d.mac) || {};
    return { mac: d.mac, ip: d.ip, host: d.host, vendor: d.vendor, note: prev.note || d.note || "" };
  });
  await writeFile(BASELINE, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nBaseline saved: ${merged.length} device(s) -> ${BASELINE}`);
}
