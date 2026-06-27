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

// Collapse near-duplicate findings. An LLM watcher (Frank, re-run every heartbeat
// tick) can re-flag the SAME ongoing thing over and over — the real incident that
// spammed the family was the "EIGHTH distinct overnight" pile-up: ~40 findings +
// alerts for one benign situation. Prompt guards (triage + persona) are supposed
// to stop the false positive, but they're not reliable, so this is the
// DETERMINISTIC backstop: while a finding is still OPEN, re-logging the same
// signature just bumps its count instead of creating a new row. The signature
// strips ordinals/counts/dates/punctuation so "...EIGHTH..." and "...NINTH..."
// collapse to one. Resolved findings don't suppress a genuinely new recurrence.
export function findingSignature(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\b(\d+(st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\b/g, " ")
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
}

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
  // Dedup against still-OPEN findings with the same signature: bump count +
  // lastSeenAt instead of piling on a new row (and signal the caller via
  // `deduped` so it can skip re-alerting). This is what caps the flood.
  const sig = findingSignature(title);
  const dup = sig && db.items.find((f) => f && f.status === "open" && findingSignature(f.title) === sig);
  if (dup) {
    dup.count = (dup.count || 1) + 1;
    dup.lastSeenAt = new Date().toISOString();
    if (SECURITY_SEVERITIES.indexOf(sev) > SECURITY_SEVERITIES.indexOf(dup.severity)) dup.severity = sev;
    await save(db);
    return { ...dup, deduped: true };
  }
  const item = {
    id: randomUUID().slice(0, 8),
    title: String(title).trim(),
    severity: sev,
    summary,
    recommendation,
    status: "open",
    count: 1,
    createdAt: new Date().toISOString(),
  };
  db.items.push(item);
  await save(db);
  return item;
}

export async function listFindings() {
  return (await load()).items;
}
