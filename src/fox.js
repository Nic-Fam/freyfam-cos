import { TableClient } from "@azure/data-tables";
import { AZURE, DIGEST } from "./config.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Fox's day at Bright Horizons: today's activities + a derived WARDROBE HINT so
// Nic/Shelli can dress him right (old clothes on paint/messy days, a full change
// on water days). Ported from the legacy assistant, SAME Azure table so existing
// captured days carry over and either side can write it.
//
//   Table 'foxDailyContext'  PartitionKey 'fox'  RowKey 'YYYY-MM-DD' (LA day)
//   fields: lessonPlan, themeOrUnit, activities, clothingHint, mealsJson
//
// Populated from Bright Horizons emails: under the cutover those arrive at the
// daemon, so Lloyd parses them and calls set_fox_day (see the house rule). The
// morning digest reads getFoxToday and renders the section.
// ===========================================================================

const log = createLogger("fox");
const TABLE = "foxDailyContext";
const PARTITION = "fox";

let _client;
function table() {
  if (!_client) _client = TableClient.fromConnectionString(AZURE.queueConnectionString, TABLE);
  return _client;
}
async function ensureTable() {
  try {
    await table().createTable();
  } catch (e) {
    if (e.statusCode !== 409) throw e;
  }
}

export function foxDayKey(now = new Date(), tz = DIGEST.tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Pure: derive a wardrobe hint from the day's activity/lesson text. Exported for
// tests — this is the heart of "plan wardrobe around paint/water days".
export function deriveClothingHint(text) {
  const t = String(text || "").toLowerCase();
  const hints = [];
  if (/\b(paint|painting|finger ?paint|messy|sensory|mud|clay|dough|glue|marker|stain|dye)\b/.test(t))
    hints.push("old or washable clothes (messy play)");
  if (/\b(water|splash|sprinkler|pool|swim|wet|sponge|bubbles?|hose)\b/.test(t))
    hints.push("pack a full change of clothes and a towel (water play)");
  if (/\b(outdoor|outside|park|field trip|hike|nature walk|garden|playground)\b/.test(t))
    hints.push("weather-ready outdoor clothes and closed shoes");
  return hints.join("; ");
}

const safeJSON = (s, f) => { try { return JSON.parse(s); } catch { return f; } };

/** Today's (or a given day's) Fox context, shaped for the digest. null if none. */
export async function getFoxToday(dateStr = foxDayKey()) {
  try {
    const e = await table().getEntity(PARTITION, dateStr);
    return {
      date: e.rowKey,
      lessonPlan: e.lessonPlan || "",
      themeOrUnit: e.themeOrUnit || "",
      activities: e.activities || "",
      clothingHint: e.clothingHint || "",
      meals: e.mealsJson ? safeJSON(e.mealsJson, {}) : {},
    };
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

/**
 * Upsert a day's Fox context (non-clobbering merge). If no clothingHint is given,
 * derive one from activities/lessonPlan so the wardrobe note is always present
 * when the day involves messy/water/outdoor play.
 */
export async function setFoxDay(dateStr, fields = {}) {
  if (!dateStr) throw new Error("setFoxDay requires a date (YYYY-MM-DD)");
  await ensureTable();
  let existing = {};
  try {
    existing = await table().getEntity(PARTITION, dateStr);
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const activities = fields.activities || existing.activities || "";
  const lessonPlan = fields.lessonPlan || existing.lessonPlan || "";
  const clothingHint =
    fields.clothingHint || existing.clothingHint || deriveClothingHint(`${activities} ${lessonPlan}`);
  const row = {
    partitionKey: PARTITION,
    rowKey: dateStr,
    lessonPlan,
    activities,
    themeOrUnit: fields.themeOrUnit || existing.themeOrUnit || "",
    clothingHint,
    mealsJson: fields.meals ? JSON.stringify({ ...(existing.mealsJson ? safeJSON(existing.mealsJson, {}) : {}), ...fields.meals }) : existing.mealsJson || "",
    capturedAt: new Date().toISOString(),
  };
  await table().upsertEntity(row, "Replace");
  log.info("fox day saved", { date: dateStr, clothingHint });
  return row;
}

/** Render the Fox section for the digest. null when there's nothing useful. */
export function formatFox(ctx) {
  if (!ctx) return null;
  const lines = [`Fox today${ctx.themeOrUnit ? ` (${ctx.themeOrUnit})` : ""}:`];
  if (ctx.activities) lines.push(`  Activities: ${ctx.activities}`);
  else if (ctx.lessonPlan) lines.push(`  Lesson: ${ctx.lessonPlan}`);
  if (ctx.clothingHint) lines.push(`  Wardrobe: ${ctx.clothingHint}`);
  return lines.length > 1 ? lines.join("\n") : null;
}
