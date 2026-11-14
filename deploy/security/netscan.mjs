#!/usr/bin/env node
// Frank's repeatable LAN device scan + baseline diff.
//
// Scans every directly-attached LAN subnet (ping sweep -> ARP table), then compares
// the live set of devices against a saved baseline and reports what is NEW, what is
// GONE, and which known devices changed IP. Identity is keyed by MAC (stable across
// DHCP), not IP. Offline-only: no external calls, OUI vendor from a small local map.
//
// Usage:
//   node deploy/security/netscan.mjs              # scan + diff against baseline
//   node deploy/security/netscan.mjs --save       # scan, then add/refresh everything
//                                                 # seen in the baseline (keeps notes and
//                                                 # keeps known devices that are offline)
//   node deploy/security/netscan.mjs --json       # machine-readable diff to stdout
//
// Baseline lives at data/network-baseline.json (gitignored via data/*), so MACs
// never hit git.
//
// Multi-subnet: ARP only sees the networks this box is physically on. The Eero
// runs its own NAT'd IoT subnet (Ring, Lockly) behind the Asus router, so Frank
// gets a second NIC (USB Ethernet adapter into an Eero LAN port) and this scan
// sweeps every LAN interface it finds. NETSCAN_IFACES=en0,en7 pins the list.
// Subnets wider than a /22 are clamped to the /22 around this box.
//
// Scope note: ping-silent devices won't populate ARP unless they talk to this
// box, so treat "GONE" as "not seen this run", not proof of removal.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { addFinding, listFindings, resolveFinding } from "../../src/security.js";
import {
  parseIfconfig, hostsOf, parseArp, diffScan, mergeBaseline, pool,
} from "../../src/netscan.js";

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

const ouiOf = (mac) => OUI[mac.split(":").slice(0, 3).join(":")] || "unknown";

// Locally-administered ("private Wi-Fi" / randomized) MAC: the 0x02 bit is set in
// the first octet. Phones and laptops rotate these for privacy, so they can't be
// stably baselined and would otherwise generate a perpetual stream of false "new
// device" findings. We still LIST them in a scan, but skip recording findings.
const isRandomMac = (mac) => (parseInt(mac.split(":")[0], 16) & 0x02) !== 0;

async function localSubnets() {
  const { stdout } = await exec("ifconfig").catch(() => ({ stdout: "" }));
  const only = process.env.NETSCAN_IFACES
    ? process.env.NETSCAN_IFACES.split(",").map((x) => x.trim()).filter(Boolean)
    : null;
  const subnets = parseIfconfig(stdout, only);
  if (!subnets.length) throw new Error("no LAN IPv4 subnet found on any interface");
  return subnets;
}

async function pingSweep(subnet) {
  // We don't care about replies, only that the ARP cache gets populated for hosts
  // that answer at L2. Capped concurrency: an Eero /22 is 1022 addresses.
  await pool(hostsOf(subnet).filter((ip) => ip !== subnet.self), 128, (ip) =>
    exec("ping", ["-c1", "-W300", ip]).catch(() => {})
  );
}

async function readArp(subnets) {
  const { stdout } = await exec("arp", ["-a"]).catch(() => ({ stdout: "" }));
  return parseArp(stdout, subnets, ouiOf);
}

async function loadBaseline() {
  try {
    const raw = JSON.parse(await readFile(BASELINE, "utf8"));
    return Array.isArray(raw) ? raw : raw.devices || [];
  } catch {
    return null; // no baseline yet
  }
}

function fmt(d) {
  const note = d.note ? `  — ${d.note}` : "";
  return `${d.ip.padEnd(15)} ${d.mac}  ${d.vendor.padEnd(10)} ${d.host || "(no name)"}${note}`;
}

const subnets = await localSubnets();
for (const s of subnets) await pingSweep(s);
const ipKey = (ip) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const current = (await readArp(subnets)).sort((a, b) => ipKey(a.ip) - ipKey(b.ip));
const baseline = await loadBaseline();
const diff = (base, cur) => diffScan(base, cur, subnets);
const where = (d) => subnets.find((s) => s.cidr === d.subnet) || subnets[0];

if (JSON_OUT) {
  const d = baseline ? diff(baseline, current) : { added: current, gone: [], movedIp: [] };
  console.log(JSON.stringify({ subnets, current, ...d }, null, 2));
} else {
  for (const s of subnets) {
    const here = current.filter((d) => d.subnet === s.cidr);
    const note = s.clamped ? " (clamped to /22)" : "";
    console.log(`\nScan of ${s.cidr}${note} on ${s.iface} from ${s.self} — ${here.length} host(s) seen\n`);
    for (const d of here) console.log("  " + fmt(d));
  }

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
      summary: `Unrecognized device on ${d.subnet} (${where(d).iface}) seen by Frank's scheduled scan: ${d.ip} MAC ${d.mac} vendor ${d.vendor}, hostname "${d.host || "(none)"}". Not in the network baseline.`,
      recommendation: `Confirm it's expected. If yes, add to baseline: node deploy/security/netscan.mjs --save. If unknown, investigate and consider isolating it on the IoT/guest subnet.`,
    });
    logged++;
  }
  if (!JSON_OUT) console.log(`\nRecorded ${logged} new-device finding(s) to Frank's security store.${skippedRandom ? ` Skipped ${skippedRandom} randomized-MAC (personal) device(s).` : ""}`);
}

if (SAVE) {
  // Preserve human-added notes by MAC, and keep baselined devices that are merely
  // offline this run (absence doesn't revoke trust).
  const merged = mergeBaseline(baseline, current);
  await writeFile(BASELINE, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nBaseline saved: ${merged.length} device(s) -> ${BASELINE}`);

  // Baselining a device means it's now trusted, so auto-resolve any open
  // "New device on LAN" finding whose MAC is now in the baseline. Closes the
  // loop: --save both stops future alerts and clears the ones already logged.
  const macs = new Set(merged.map((d) => d.mac));
  let resolved = 0;
  for (const f of (await listFindings()).filter((f) => f && f.status === "open" && /^New device on LAN/.test(f.title))) {
    const mac = (f.summary || "").toLowerCase().match(/mac ([0-9a-f:]{11,17})/)?.[1];
    if (mac && macs.has(mac)) { await resolveFinding(f.id, { note: "baselined via netscan --save" }); resolved++; }
  }
  if (resolved) console.log(`Auto-resolved ${resolved} finding(s) for now-baselined device(s).`);
}
