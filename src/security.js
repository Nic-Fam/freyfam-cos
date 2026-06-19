// Security findings log for Frank (the security specialist). Per his persona and
// the hard constraints, Frank watches, flags, and advises but NEVER takes control
// actions (no arm/disarm, lock, password/account changes). His only write tool
// records a finding here for a human to review and act on through the confirmation
// gate. Local JSON, no side effects, and never stores secrets/credentials.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const PATH = () => process.env.SECURITY_FINDINGS_PATH || "./data/security-findings.json";

export const SECURITY_SEVERITIES = ["info", "low", "medium", "high", "critical"];

async function load() {
  try {
    return JSON.parse(await readFile(PATH(), "utf8"));
  } catch {
    return { items: [] };
  }
}
async function save(db) {
  await mkdir(dirname(PATH()), { recursive: true });
  await writeFile(PATH(), JSON.stringify(db, null, 2));
}

/** @param {{title:string, severity?:string, summary?:string, recommendation?:string}} input */
export async function addFinding({ title, severity = "info", summary = "", recommendation = "" } = {}) {
  if (!title || !String(title).trim()) throw new Error("title is required");
  const sev = SECURITY_SEVERITIES.includes(String(severity).toLowerCase())
    ? String(severity).toLowerCase()
    : "info";
  const db = await load();
  const item = {
    id: randomUUID().slice(0, 8),
    title: String(title).trim(),
    severity: sev,
    summary,
    recommendation,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  db.items.push(item);
  await save(db);
  return item;
}

export async function listFindings() {
  return (await load()).items;
}
