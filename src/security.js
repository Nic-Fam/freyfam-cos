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

/**
 * Mark an OPEN finding resolved by id. Bookkeeping only — like every security
 * write, it takes no control action. Returns the updated finding, or null if the
 * id isn't found. Idempotent: resolving an already-resolved finding is a no-op
 * that still returns it. A resolved finding no longer suppresses a genuinely new
 * recurrence (addFinding's dedup only collapses OPEN ones).
 * @param {string} id
 * @param {{note?:string}} [opts]
 */
export async function resolveFinding(id, { note = "" } = {}) {
  if (!id || !String(id).trim()) throw new Error("id is required");
  const db = await load();
  const f = db.items.find((x) => x && x.id === id);
  if (!f) return null;
  if (f.status !== "resolved") {
    f.status = "resolved";
    f.resolvedAt = new Date().toISOString();
    if (note) f.resolvedNote = String(note);
    await save(db);
  }
  return f;
}

const SIG_STOP = new Set("a an the of to in on for and or is are was were be it its this that from with at by as our we fine ok okay handled expected".split(" "));
const sigWords = (t) => [...new Set((String(t || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !SIG_STOP.has(w)))];

/**
 * Close OPEN findings the family has accepted, by id or by topic (2026-10-26).
 * The family's word is final: no proof is required, and nothing is re-opened
 * unless a genuinely new finding is logged later. Topic matching is generous on
 * purpose (the family describes an issue in their own words): a finding matches
 * when its title contains the phrase, or when at least half of the phrase's
 * significant words appear in its title + summary. Returns what was closed and
 * what is still open, so the caller can retry with an id.
 * @param {{ids?:string[], match?:string, note?:string, by?:string}} opts
 */
export async function resolveMatching({ ids = [], match = "", note = "", by = "family" } = {}) {
  const db = await load();
  const open = db.items.filter((f) => f && f.status === "open");
  const idSet = new Set((ids || []).map(String));
  const words = sigWords(match);
  const m = String(match || "").toLowerCase().trim();
  // Ids and exact phrase matches close outright. Otherwise score by word overlap
  // and close only the BEST match(es): "the Ring device on the LAN" must close the
  // Ring finding, not every "New device on LAN" finding that shares two words.
  const byId = open.filter((f) => idSet.has(f.id));
  const byPhrase = m ? open.filter((f) => !idSet.has(f.id) && String(f.title || "").toLowerCase().includes(m)) : [];
  let byWords = [];
  if (!byId.length && !byPhrase.length && words.length >= 1) {
    const scored = open.map((f) => {
      const hay = sigWords(`${f.title} ${f.summary || ""}`);
      return { f, score: words.filter((w) => hay.includes(w)).length / words.length };
    });
    const best = Math.max(0, ...scored.map((x) => x.score));
    if (best >= 0.5) byWords = scored.filter((x) => x.score === best).map((x) => x.f);
  }
  const hits = [...byId, ...byPhrase, ...byWords];
  const now = new Date().toISOString();
  for (const f of hits.slice(0, 20)) {
    f.status = "resolved";
    f.resolvedAt = now;
    f.resolvedBy = by;
    if (note) f.resolvedNote = String(note);
  }
  if (hits.length) await save(db);
  return {
    closed: hits.slice(0, 20).map((f) => ({ id: f.id, title: f.title })),
    stillOpen: db.items.filter((f) => f && f.status === "open").map((f) => ({ id: f.id, title: f.title, severity: f.severity })),
  };
}
