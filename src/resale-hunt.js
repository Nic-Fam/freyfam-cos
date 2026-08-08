// The ONE resale hunt avenue. Shey searches for the family's tracked pieces across
// EVERY source in a single pass -- the resale sites (eBay / Poshmark / Depop /
// Grailed / TheRealReal / Vestiaire / ... via the source router) AND the vintage
// archive boutiques AND TheRealReal First Look -- then applies an INTELLIGENCE pass
// that rates how likely each candidate actually IS a hunted piece (same brand AND
// the distinctive descriptor, judged from title/price and the listing photo when
// the source carries one). Only the pieces on the hunt list survive; each surfaced
// find is labelled with its likelihood. One consolidated, deduped notification.
//
// Two stages keep it honest and cheap:
//   1. Gather + cheap pre-filter -- drop category/search landing pages (not real
//      listings) and anything with no DISTINCTIVE (non-generic) hunt term, so we
//      don't spend model tokens on obvious non-matches.
//   2. Intelligence pass (Sonnet, with photos where available) -- score 0-100 and
//      drop everything below the floor. This is what "only what we asked for, and
//      anything that could be those items" means, and it restores the per-listing
//      likelihood the family used to get.

import { runSavedSearches, huntTokens } from "./saved-searches.js";
import { runBoutiqueFeeds, canonicalHref } from "./boutique-feed.js";
import { runFirstLookFeed } from "./resale-feed.js";
import { complete, textOf, parseJson } from "./claude.js";
import { MODELS } from "./config.js";
import { createLogger } from "./log.js";

const log = createLogger("resale-hunt");

const FLOOR = () => Number(process.env.RESALE_MATCH_FLOOR || 60);
const ASSESS_MODEL = () => process.env.MODEL_RESALE_ASSESS || process.env.MODEL_STANDARD || MODELS.standard;

// Generic fashion words that do NOT distinguish a specific piece. A hunt term that
// isn't one of these (e.g. a brand or a model/season code: dior, dsquared2, ethnie,
// fw2014) is "distinctive": a candidate must share at least one to be worth scoring.
const GENERIC = new Set(
  ("sandal sandals shoe shoes heel heels boot boots top tops tee shirt blouse bag bags purse dress skirt " +
   "pant pants jean jeans jacket coat sweater knit women woman womens men man mens unisex size sizes small " +
   "medium large xs new used vintage preowned pre owned designer luxury authentic buy sell shop listing " +
   "collective marketplace for and the your with from item")
    .split(/\s+/)
);

/** Non-generic (brand/model/season) terms for a hunt. Pure. */
export function distinctiveTokens(hunt) {
  return huntTokens(hunt).filter((t) => !GENERIC.has(t));
}

/** True when the text shares at least one distinctive term with SOME hunt. Pure. */
export function hasDistinctive(text, hunts) {
  const hay = String(text || "").toLowerCase();
  return (Array.isArray(hunts) ? hunts : []).some((h) => distinctiveTokens(h).some((t) => hay.includes(t)));
}

/**
 * True for a real item-listing URL, false for a category/search landing page. The
 * morning firehose was full of Vestiaire category pages
 * (/women-shoes/sandals/christian-dior/) surfaced as if they were listings. Pure.
 */
export function looksLikeListing(url) {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  if (/[?&](q|query|keywords|search|searchterm)=/.test(u)) return false; // search-results URL
  if (/\/(search|shop)(\/|$|\?)/.test(u)) return false;                  // search/shop landing
  // Vestiaire: a real listing ends in "-<digits>.shtml"; every other path on that
  // host (a brand/category grid) is NOT a listing.
  if (/vestiairecollective\.com/.test(u)) return /-\d{4,}\.shtml/.test(u);
  return true; // ebay /itm, poshmark /listing, boutique /products, etc.
}

/** One find, source-agnostic: {source,label,title,url,price,snippet,image}. */
function push(out, seen, item) {
  if (!item.url) return;
  const key = canonicalHref(item.url);
  if (seen.has(key)) return; // same piece surfaced by two sources
  seen.add(key);
  out.push(item);
}

/**
 * Intelligence pass: rate each candidate 0-100 on how likely it IS a hunted piece
 * (same brand AND the specific piece), using the photo when present. Drops anything
 * below `floor` (off the hunt list). Returns survivors annotated with {likelihood,
 * reason}. On assessor failure it degrades to surfacing the candidates UNSCORED
 * (better a labelled maybe than a silently dropped real find). Injectable for tests.
 */
export async function assessCandidates(candidates, hunts, { model = ASSESS_MODEL(), floor = FLOOR(), completeImpl = complete } = {}) {
  if (!candidates.length) return [];
  const huntList = (hunts || []).map((h, i) => `#${i + 1} ${h.label} (search: "${h.query}")`).join("\n");
  const system =
    "You are Shey, the family's resale eye. Given the pieces the family is hunting and a list of candidate listings, judge for EACH candidate the likelihood (0-100) that it IS one of the hunted pieces. " +
    "It must be the SAME BRAND and the SAME specific piece -- matching the distinctive descriptors (model, season, material) -- not merely a similar-looking item. " +
    "A different brand, a different model, or a category/search page is NOT a match (score <= 20). Use the listing PHOTO when one is provided. " +
    'Reply with ONLY a JSON object: {"verdicts":[{"i":<index>,"hunt":<hunt number or null>,"likelihood":<0-100>,"reason":"<=12 words"}]} -- one entry per candidate, in the given order.';
  const content = [{ type: "text", text: `Hunted pieces (the ONLY things we want):\n${huntList}\n\nCandidates:` }];
  candidates.forEach((c, i) => {
    content.push({ type: "text", text: `[${i}] ${c.title || "(untitled)"}${c.price != null ? ` ($${c.price})` : ""}${c.snippet ? ` -- ${c.snippet}` : ""}\n${c.url}` });
    if (c.image) content.push({ type: "image", source: { type: "url", url: c.image } });
  });

  let verdicts;
  try {
    const resp = await completeImpl({ model, system, messages: [{ role: "user", content }], maxTokens: 1500 });
    verdicts = parseJson(textOf(resp))?.verdicts;
    if (!Array.isArray(verdicts)) throw new Error("assessment had no verdicts array");
  } catch (e) {
    log.warn("resale assessment failed; surfacing candidates unscored", { reason: e.message, candidates: candidates.length });
    return candidates.map((c) => ({ ...c, likelihood: null, reason: "match unscored (assessor unavailable)" }));
  }

  const byIndex = new Map(verdicts.filter((v) => v && Number.isInteger(v.i)).map((v) => [v.i, v]));
  const out = [];
  candidates.forEach((c, i) => {
    const v = byIndex.get(i);
    const likelihood = v && Number.isFinite(v.likelihood) ? Math.max(0, Math.min(100, Math.round(v.likelihood))) : null;
    if (likelihood != null && likelihood < floor) return; // not on the hunt list -> drop
    out.push({ ...c, likelihood, reason: v?.reason || "" });
  });
  return out;
}

/**
 * Run the single hunt search across all sources and return the consolidated,
 * assessed new finds. `hunts` is the active hunt list (the only source of scope).
 * Readers + the assessor are injectable for tests. `scope` passes to the site
 * search ("all" runs every site on Lloyd, who has the browser + eBay API + Brave).
 */
export async function runHuntSearch({
  hunts = [],
  scope = "all",
  siteRunner = runSavedSearches,
  boutiqueRunner = runBoutiqueFeeds,
  firstLookRunner = runFirstLookFeed,
  assess = assessCandidates,
} = {}) {
  const empty = { newItems: [], counts: { site: 0, boutique: 0, firstlook: 0 }, gathered: 0, candidates: 0 };
  if (!Array.isArray(hunts) || !hunts.length) return empty;
  const gathered = [];
  const seen = new Set();
  const counts = { site: 0, boutique: 0, firstlook: 0 };

  // Resale sites (honed to each hunt). One provider hiccup must not sink the rest.
  try {
    const runs = await siteRunner({ scope, searches: hunts, hone: true });
    for (const r of runs || []) for (const h of r.newHits || []) {
      push(gathered, seen, { source: "site", label: r.label, title: h.title || "New listing", url: h.url, price: h.price ?? null, snippet: h.snippet || "", image: h.image || "" });
      counts.site += 1;
    }
  } catch (e) { log.warn("resale site search failed", { reason: e.message }); }

  // Vintage / archive boutiques (already honed inside the reader).
  try {
    const feeds = await boutiqueRunner({ hunts });
    for (const f of feeds || []) for (const it of f.newItems || []) {
      push(gathered, seen, { source: "boutique", label: f.name, title: it.name || "New listing", url: it.url || it.href, price: it.price ?? null, snippet: "", image: it.image || "" });
      counts.boutique += 1;
    }
  } catch (e) { log.warn("resale boutique feed failed", { reason: e.message }); }

  // TheRealReal First Look member early access (already honed inside the reader).
  try {
    const fl = await firstLookRunner({ hunts });
    for (const it of fl?.newItems || []) {
      const title = [it.brand, it.item].filter(Boolean).join(" ") || "New listing";
      push(gathered, seen, { source: "firstlook", label: "First Look", title, url: it.url || it.href, price: it.price ?? null, snippet: "", image: it.image || "" });
      counts.firstlook += 1;
    }
  } catch (e) { log.warn("resale first-look feed failed", { reason: e.message }); }

  // Cheap pre-filter before spending model tokens: real listings only, and only
  // those sharing a distinctive (non-generic) hunt term.
  const candidates = gathered.filter((it) => looksLikeListing(it.url) && hasDistinctive(`${it.title} ${it.snippet}`, hunts));
  // Intelligence pass: score + drop everything not clearly on the hunt list.
  const newItems = await assess(candidates, hunts);
  return { newItems, counts, gathered: gathered.length, candidates: candidates.length };
}

/** Human summary of the consolidated finds, grouped by source, with likelihood. Pure. */
export function formatHuntFinds(newItems, { max = 20 } = {}) {
  if (!newItems || !newItems.length) return "";
  const LABELS = { site: "Sites", boutique: "Boutiques", firstlook: "First Look" };
  const shown = newItems.slice(0, max);
  const lines = [];
  for (const src of ["site", "boutique", "firstlook"]) {
    const group = shown.filter((i) => i.source === src);
    if (!group.length) continue;
    lines.push(`${LABELS[src]}:`);
    for (const i of group) {
      const pct = i.likelihood != null ? `[${i.likelihood}%] ` : "";
      const why = i.reason ? ` -- ${i.reason}` : "";
      lines.push(`- ${pct}${i.title}${i.price != null ? ` ($${i.price})` : ""}${why}\n  ${i.url}`);
    }
  }
  if (newItems.length > max) lines.push(`...and ${newItems.length - max} more`);
  return lines.join("\n");
}
