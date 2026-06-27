// Monthly spending baselines per source (credit vs checking), so the weekly
// finance report can do month-over-month and year-over-year comparisons from
// day one. Completed months live here (seeded from historical statements/CSVs,
// and appended as each month closes); the current month-to-date is computed live
// from the transaction log. Surfacing only — never moves money.
//
// One row per {source, ym}. Pluggable storage like the rest (local JSON or the
// finance specialist's Azure Table).

import { createCollection } from "./stores/collection.js";

const col = () =>
  createCollection({
    file: process.env.FINANCE_BASELINES_PATH || "./data/finance-baselines.json",
    partition: "financebaseline",
  });

const round2 = (x) => Math.round(Number(x) * 100) / 100;
const key = (source, ym) => `${source}:${ym}`; // ym = "YYYY-MM" (or "YYYY" for an annual context row)

/** Upsert a completed-month total (and optional category breakdown) for a source. */
export async function setMonthly({ source, ym, total, byCategory = null, note = null } = {}) {
  if (!source || !ym) throw new Error("source and ym are required");
  const id = key(source, ym);
  const c = col();
  await c.remove(id).catch(() => {});
  const item = { id, source, ym, total: round2(total || 0), byCategory, note, at: new Date().toISOString() };
  await c.add(item);
  return item;
}

export async function getMonthly(source, ym) {
  const items = await col().list();
  return items.find((it) => it.id === key(source, ym)) || null;
}

export async function listMonthly({ source } = {}) {
  let items = await col().list();
  if (source) items = items.filter((it) => it.source === source);
  // chronological by ym (annual "YYYY" rows sort before that year's months, which is fine)
  return items.sort((a, b) => String(a.ym).localeCompare(String(b.ym)));
}

// ym helpers
function shiftMonth(ym, deltaMonths) {
  const [y, m] = String(ym).split("-").map(Number);
  if (!y || !m) return null;
  const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function delta(current, prior) {
  if (prior == null) return { current, prior: null, deltaAbs: null, deltaPct: null };
  const deltaAbs = round2(current - prior);
  const deltaPct = prior === 0 ? null : Math.round((deltaAbs / prior) * 1000) / 10;
  return { current, prior: round2(prior), deltaAbs, deltaPct };
}

/**
 * Month-over-month for a source. `currentTotal` is usually the live month-to-date
 * (from the log); the prior month comes from the baseline store.
 */
export async function monthOverMonth({ source, ym, currentTotal }) {
  const priorYm = shiftMonth(ym, -1);
  const prior = priorYm ? await getMonthly(source, priorYm) : null;
  return { source, ym, priorYm, ...delta(round2(currentTotal || 0), prior ? prior.total : null) };
}

/** Year-over-year: same month, prior year, from the baseline store. */
export async function yearOverYear({ source, ym, currentTotal }) {
  const priorYm = shiftMonth(ym, -12);
  const prior = priorYm ? await getMonthly(source, priorYm) : null;
  return { source, ym, priorYm, ...delta(round2(currentTotal || 0), prior ? prior.total : null) };
}

/** Compact human line for the report, e.g. "MoM +12.3% ($1,234 vs $1,099)". */
export function formatDelta(label, d) {
  if (!d || d.prior == null) return `${label}: no prior data`;
  const dir = d.deltaAbs > 0 ? "+" : d.deltaAbs < 0 ? "-" : "";
  const pct = d.deltaPct == null ? "" : ` ${dir}${Math.abs(d.deltaPct)}%`;
  return `${label}:${pct} ($${d.current.toFixed(2)} vs $${d.prior.toFixed(2)})`;
}
