import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { MODELS } from "./config.js";
import { listModels as defaultListModels } from "./claude.js";
import { createLogger } from "./log.js";

const log = createLogger("model-registry");

// ===========================================================================
// Keep the model tiers current as Anthropic ships new models, WITHOUT hardcoding
// the next ID. The tiers in config.js (triage=Haiku, standard=Sonnet, heavy=Opus)
// are the cost strategy; this resolves each tier to the NEWEST model in its family
// from the live Models API (GET /v1/models), by release date.
//
// Family -> tier mapping mirrors config.js. Heavy stays on the OPUS family on
// purpose: claude-fable-*/claude-mythos-* are premium (multiples of Opus pricing),
// so auto-jumping there would silently blow the budget — that's an explicit
// human choice, not an auto-bump.
//
// DETECT, don't silently swap: discoverModelTiers reports `changes` so the
// heartbeat can NOTIFY the owner that a newer model exists. Changing the model a
// running household uses shifts cost and behavior, which is a human decision
// (same principle as the confirmation gate). Auto-apply is opt-in (see heartbeat).
// ===========================================================================

const FAMILIES = { triage: "claude-haiku", standard: "claude-sonnet", heavy: "claude-opus" };

const isDatedSnapshot = (id) => /-\d{8}$/.test(String(id || ""));
const ts = (m) => Date.parse(m?.created_at || "") || 0;

/** Newest model id in a family, preferring the undated alias over a dated snapshot. */
export function newestInFamily(models, prefix) {
  const fam = (models || []).filter((m) => String(m?.id || "").startsWith(prefix));
  if (!fam.length) return null;
  fam.sort((a, b) => ts(b) - ts(a));
  const newest = fam.filter((m) => ts(m) === ts(fam[0]));
  const alias = newest.find((m) => !isDatedSnapshot(m.id));
  return (alias || newest[0]).id;
}

/**
 * Resolve {triage, standard, heavy} to the newest model per family from the live
 * catalog. Falls back to the configured tier for any family the API doesn't return
 * (or on error), so a transient failure never blanks a tier.
 * @returns {Promise<{tiers, changes, ok}>} changes: [{tier, from, to}] where newer exists.
 */
export async function discoverModelTiers({ listModels = defaultListModels, fallback = MODELS } = {}) {
  let models;
  try {
    models = await listModels();
  } catch (err) {
    log.error("models list failed; keeping configured tiers", { reason: err.message });
    return { tiers: { ...fallback }, changes: [], ok: false };
  }
  const tiers = { ...fallback };
  const changes = [];
  for (const [tier, prefix] of Object.entries(FAMILIES)) {
    const latest = newestInFamily(models, prefix);
    if (!latest) continue; // family missing from catalog -> keep configured
    tiers[tier] = latest;
    if (latest !== fallback[tier]) changes.push({ tier, from: fallback[tier], to: latest });
  }
  return { tiers, changes, ok: true };
}

/** A short stable key for a change set, for notify de-duplication. */
export function changeKey(changes) {
  return (changes || []).map((c) => `${c.tier}:${c.to}`).sort().join(",");
}

// Persisted across restarts so we notify ONCE per distinct new release, not once
// per daemon boot. (The original in-memory dedup reset on every restart, so a
// frequently-restarted daemon re-emailed the same "new model available" notice.)
const statePath = () => process.env.MODEL_NOTIFY_STATE_PATH || "./data/model-notify-state.json";

export async function getModelNotifyState() {
  try {
    const s = JSON.parse(await readFile(statePath(), "utf8"));
    return { lastCheckAt: Number(s.lastCheckAt) || 0, notifiedKey: s.notifiedKey ?? null };
  } catch {
    return { lastCheckAt: 0, notifiedKey: null };
  }
}

export async function setModelNotifyState({ lastCheckAt, notifiedKey }) {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify({ lastCheckAt, notifiedKey }, null, 2));
}
