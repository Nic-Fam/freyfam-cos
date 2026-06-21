import { createRequire } from "node:module";
import { deriveClothingHint } from "./fox.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Parse a Bright Horizons WEEKLY curriculum PDF into PER-DAY activities so the
// morning digest can tell us how to dress Fox each day, not just for the week.
//
// The PDF is a Monday-Friday grid. pdf-parse's plain text flattens the columns
// together, but each weekday NAME sits as its own text item at the top of its
// column — so we anchor on those x-positions and assign every grid item to the
// nearest day column. This survives the irregular column widths and the items
// that bridge column gaps (a plain max-gap clustering merged Thu+Fri).
//
// Falls back to null if it doesn't look like a weekday grid (template change),
// so the caller can degrade to flat-text handling.
// ===========================================================================

const log = createLogger("fox-curriculum");
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const FETCH_TIMEOUT_MS = Number(process.env.DOC_FETCH_TIMEOUT_MS || 25000);
const MAX_FETCH_BYTES = Number(process.env.DOC_MAX_FETCH_BYTES || 15_000_000);

/** Dates (YYYY-MM-DD) for Mon..Fri given a "Week of M/D/YYYY" string. UTC-noon avoids DST day-shift. */
export function weekDates(weekOfStr, count = 5) {
  const m = String(weekOfStr || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return [];
  const [, mo, d, y] = m.map(Number);
  return Array.from({ length: count }, (_, i) => {
    const dt = new Date(Date.UTC(y, mo - 1, d + i, 12));
    return dt.toISOString().slice(0, 10);
  });
}

function linesFromItems(items) {
  const sorted = items.slice().sort((a, b) => b.y - a.y);
  const lines = [];
  let line = [];
  let ly = null;
  for (const it of sorted) {
    if (ly === null || Math.abs(it.y - ly) <= 6) line.push(it.s.trim());
    else {
      lines.push(line.join(" ").trim());
      line = [it.s.trim()];
    }
    ly = it.y;
  }
  if (line.length) lines.push(line.join(" ").trim());
  return lines.filter(Boolean).join("\n").replace(/\n{2,}/g, "\n");
}

/**
 * @param {Buffer} bytes  the curriculum PDF
 * @returns {Promise<{weekOf:string, days:{date:string, day:string, activities:string, clothingHint:string}[]}|null>}
 */
export async function parseFoxWeek(bytes, { importer } = {}) {
  let pdf;
  try {
    pdf = importer ? (await importer()).default || (await importer()) : createRequire(import.meta.url)("pdf-parse");
  } catch {
    return null;
  }
  let full = "";
  const pages = [];
  try {
    await pdf(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), {
      pagerender: async (p) => {
        const tc = await p.getTextContent();
        const items = tc.items.map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str })).filter((i) => i.s.trim());
        pages.push(items);
        full += tc.items.map((it) => it.str).join(" ") + "\n";
        return "";
      },
    });
  } catch (err) {
    log.warn("curriculum parse failed", { reason: err.message });
    return null;
  }

  // Find the grid page: one where >=4 weekday names appear as standalone items.
  let grid = null;
  let anchors = null;
  for (const items of pages) {
    const xs = DAYS.map((d) => items.find((i) => i.s.trim() === d)?.x ?? null);
    if (xs.filter((x) => x != null).length >= 4) {
      grid = items;
      anchors = xs;
      break;
    }
  }
  if (!grid) return null;

  const present = anchors.map((x, i) => ({ x, i })).filter((o) => o.x != null);
  const buckets = Object.fromEntries(present.map((o) => [o.i, []]));
  for (const it of grid) {
    if (it.y > 640 || it.y < 40) continue; // strip page header/footer rows
    let best = present[0];
    let bd = Infinity;
    for (const o of present) {
      const dist = Math.abs(it.x - o.x);
      if (dist < bd) {
        bd = dist;
        best = o;
      }
    }
    buckets[best.i].push(it);
  }

  const weekOf = (full.match(/Week of\s+(\d{1,2}\/\d{1,2}\/\d{4})/i) || [])[1] || "";
  const dates = weekDates(weekOf, 5);
  const theme = (full.match(/Unit[^\n]*?:\s*[^\n]+/i) || [])[0]?.trim() || "";

  const days = present.map((o) => {
    const activities = linesFromItems(buckets[o.i]);
    return {
      date: dates[o.i] || "",
      day: DAYS[o.i],
      activities,
      themeOrUnit: theme,
      clothingHint: deriveClothingHint(activities),
    };
  });
  return { weekOf, days };
}

/** Fetch a curriculum URL (public BH media link) and parse it per-day. */
export async function fetchFoxWeek(url, { fetchImpl = fetch } = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("only http(s) URLs allowed");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_FETCH_BYTES) throw new Error(`too large (${bytes.length}B)`);
    return parseFoxWeek(bytes);
  } finally {
    clearTimeout(timer);
  }
}
