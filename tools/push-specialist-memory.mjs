// One-time migration (2026-10-26): push specialist memories and standing rules that
// were saved on LLOYD's disk to the specialist that should have them.
//
// Until today, the chief's remember(agent=...) and add_rule(agent=...) wrote to
// Lloyd's data/brain.json and data/house-rules.json, while finance/resale/chef run on
// Azure and Frank/Steve on their own Macs, each reading ITS OWN store. Those memories
// and rules never reached anyone. This script sends each one through the same
// authenticated delegate seam the daemon now uses, so it lands in the specialist's
// own store. Safe to re-run: the remote side skips duplicates.
//
//   node --env-file=.env tools/push-specialist-memory.mjs          # dry run (default)
//   node --env-file=.env tools/push-specialist-memory.mjs --apply  # actually push
//
// Only specialists configured as REMOTE are pushed. A specialist running in-process
// on Lloyd already reads Lloyd's disk, so there is nothing to move for it.

import { readFile } from "node:fs/promises";
import { delegate, chooseTransport } from "../src/delegate.js";

const APPLY = process.argv.includes("--apply");
const AGENTS = ["finance", "dev", "resale", "chef", "security"];

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

const brain = await readJson(process.env.BRAIN_PATH || "./data/brain.json", { items: [] });
const rules = await readJson(process.env.HOUSE_RULES_PATH || "./data/house-rules.json", {});

let pushed = 0, skipped = 0, failed = 0;
for (const agent of AGENTS) {
  const mems = (brain.items || []).filter((it) => it?.meta?.agent === agent && !it?.meta?.supersededBy && typeof it.text === "string");
  const agentRules = Array.isArray(rules?.agentRules?.[agent]) ? rules.agentRules[agent].filter((r) => typeof r === "string" && r.trim()) : [];
  const transport = chooseTransport(agent);
  console.log(`\n${agent}: ${mems.length} memorie(s), ${agentRules.length} rule(s) on Lloyd's disk; specialist runs ${transport}.`);
  if (transport !== "remote") {
    console.log("  in-process: already reads Lloyd's disk, nothing to push.");
    continue;
  }
  const jobs = [
    ...mems.map((m) => ({ op: "remember", args: { text: m.text }, label: `memory: ${m.text.slice(0, 70)}` })),
    ...agentRules.map((r) => ({ op: "add_rule", args: { text: r }, label: `rule: ${r.slice(0, 70)}` })),
  ];
  for (const j of jobs) {
    if (!APPLY) {
      console.log(`  would push ${j.label}`);
      continue;
    }
    const r = await delegate({ agent, op: j.op, args: j.args });
    if (r?.error) {
      failed++;
      console.log(`  FAILED ${j.label} (${r.error})`);
    } else if (r?.data?.deduped || r?.data?.added === false) {
      skipped++;
      console.log(`  already there: ${j.label}`);
    } else {
      pushed++;
      console.log(`  pushed ${j.label}`);
    }
  }
}
console.log(APPLY
  ? `\nDone: ${pushed} pushed, ${skipped} already present, ${failed} failed.`
  : "\nDry run. Re-run with --apply to push.");
process.exit(failed ? 1 : 0);
