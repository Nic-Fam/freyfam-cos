// ===========================================================================
// Hunt judge: one cheap model call decides which candidate listings ARE one of the
// family's hunted pieces. Replaces the ">=2 shared words" honing for site results,
// which let "Prosperina cocktail top with feather edge" through as "Dsquared2
// feather top" (1,155 of 1,200 saved hits were loose Poshmark matches like that).
//
// It reads each listing card's own visible text, so it also recovers the title and
// price when a site's CSS selectors drift. Each (hunt list, url) is judged ONCE and
// cached, so steady-state runs only pay for genuinely new listings. If the model is
// unavailable it falls back to the keyword match, so the feed never goes dark.
// ===========================================================================
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { complete, textOf, parseJson } from "./claude.js";
import { MODELS } from "./config.js";
import { matchesAnyHunt } from "./saved-searches.js";
import { createLogger } from "./log.js";

const log = createLogger("hunt-judge");
const CACHE_PATH = () => process.env.HUNT_VERDICTS_PATH || "./data/hunt-verdicts.json";
const CACHE_MAX = 8000;
const BATCH = 30;

const huntSig = (hunts) => hunts.map((h) => String(h.query || h.label || "").toLowerCase().trim()).sort().join("|");
const keyOf = (sig, url) => createHash("sha1").update(`${sig}|${url}`).digest("hex").slice(0, 16);

async function loadCache() {
  try { return JSON.parse(await readFile(CACHE_PATH(), "utf8")) || {}; } catch { return {}; }
}
async function saveCache(cache) {
  const entries = Object.entries(cache);
  const trimmed = entries.length > CACHE_MAX ? Object.fromEntries(entries.slice(-CACHE_MAX)) : cache;
  await mkdir(dirname(CACHE_PATH()), { recursive: true });
  await writeFile(CACHE_PATH(), JSON.stringify(trimmed));
}

/** The judging prompt for one batch. Pure (exported for tests). */
export function buildJudgePrompt(hunts, items) {
  const huntLines = hunts.map((h, i) => `H${i + 1}: ${h.query}${h.label && h.label !== h.query ? ` (${h.label})` : ""}${h.maxPrice ? `, under $${h.maxPrice}` : ""}${h.notes ? `. Notes: ${h.notes}` : ""}`).join("\n");
  const itemLines = items.map((it, i) => `L${i + 1}: ${String(it.text || it.title || "").replace(/\s+/g, " ").slice(0, 280)} <${it.url}>`).join("\n");
  return `The family is hunting for these SPECIFIC designer pieces on resale sites:
${huntLines}

Candidate listings (card text and URL):
${itemLines}

For each listing decide whether it is plausibly one of the hunted pieces: the SAME designer/brand AND the same kind of item with the defining detail (e.g. a feather sandal, not just any sandal from that brand; not a different brand's feather top). Use the URL slug too. Be strict: when unsure, it is not a match. Also read the clean item title and the price in USD from the card text when present.

Reply with ONLY JSON: {"results":[{"l":<listing number>,"h":<hunt number or 0 for no match>,"title":"<clean title>","price":<number or null>}]}`;
}

/**
 * Judge candidates against the hunts. items: [{url, title?, text?, price?}].
 * Returns the matching items enriched with {title, price, hunt}. `llm`/cache injectable.
 */
export async function judgeListings({ hunts = [], items = [], llm = complete, model = process.env.MODEL_HUNT_JUDGE || MODELS.triage, cache: cacheIn } = {}) {
  if (!hunts.length || !items.length) return [];
  const cache = cacheIn || (await loadCache());
  const sig = huntSig(hunts);
  const matches = [];
  const fresh = [];
  for (const it of items) {
    const v = cache[keyOf(sig, it.url)];
    if (v === undefined) fresh.push(it);
    else if (v && v.h) matches.push({ ...it, title: v.title || it.title, price: v.price ?? it.price ?? null, hunt: hunts[v.h - 1] });
  }
  for (let i = 0; i < fresh.length; i += BATCH) {
    const batch = fresh.slice(i, i + BATCH);
    let parsed = null;
    try {
      const resp = await llm({ model, messages: [{ role: "user", content: buildJudgePrompt(hunts, batch) }], maxTokens: 2500 });
      parsed = parseJson(textOf(resp));
    } catch (err) {
      log.warn("hunt judge unavailable, falling back to keyword match", { reason: err.message });
    }
    if (!parsed || !Array.isArray(parsed.results)) {
      // Degrade, don't go dark: keyword-match this batch and DON'T cache, so the
      // model gets a proper look next run.
      for (const it of batch) if (matchesAnyHunt(`${it.title || ""} ${it.text || ""}`, hunts)) matches.push(it);
      continue;
    }
    const byL = new Map(parsed.results.map((r) => [Number(r.l), r]));
    batch.forEach((it, j) => {
      const r = byL.get(j + 1) || { h: 0 };
      const h = Number(r.h) > 0 && Number(r.h) <= hunts.length ? Number(r.h) : 0;
      const price = Number.isFinite(Number(r.price)) && r.price !== null ? Number(r.price) : it.price ?? null;
      cache[keyOf(sig, it.url)] = h ? { h, title: r.title || null, price } : { h: 0 };
      if (h) matches.push({ ...it, title: r.title || it.title, price, hunt: hunts[h - 1] });
    });
  }
  if (fresh.length && !cacheIn) await saveCache(cache).catch((e) => log.warn("could not save verdicts", { reason: e.message }));
  // Respect a hunt's price cap once the real price is known.
  return matches.filter((m) => !(m.hunt?.maxPrice && m.price != null && m.price > Number(m.hunt.maxPrice)));
}

/** Judging is on unless RESALE_JUDGE=false (off by default under `node --test`, so
 *  the suite never calls the real model; tests inject a judge explicitly). */
export const huntJudgeEnabled = () => {
  const v = process.env.RESALE_JUDGE;
  if (v != null) return String(v).toLowerCase() !== "false";
  return !process.env.NODE_TEST_CONTEXT;
};
