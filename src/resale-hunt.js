// The ONE resale hunt avenue. Shey searches for the family's tracked pieces across
// EVERY source in a single pass -- the resale sites (eBay / Poshmark / Depop /
// Grailed / TheRealReal / Vestiaire / ... via the source router) AND the vintage
// archive boutiques AND TheRealReal First Look (member early access) -- and returns
// ONE consolidated, hunt-honed, deduped set of new finds. Sites and boutiques are
// not separate feeds anymore: they're just sources feeding this one list.
//
// Scope is the hunt list and nothing else: every source's results run through the
// same >=2-shared-terms hunt match (matchesAnyHunt / the `hone` flag on the site
// search), so only the pieces the family explicitly registered -- and listings that
// plausibly ARE those pieces -- surface. Each source keeps its own seen-store, so
// this never re-alerts; we additionally dedupe across sources by URL.

import { runSavedSearches } from "./saved-searches.js";
import { runBoutiqueFeeds } from "./boutique-feed.js";
import { runFirstLookFeed } from "./resale-feed.js";
import { canonicalHref } from "./boutique-feed.js";

/** One find, source-agnostic: {source, label, title, url, price}. */
function push(out, seen, item) {
  if (!item.url) return;
  const key = canonicalHref(item.url);
  if (seen.has(key)) return; // same piece surfaced by two sources
  seen.add(key);
  out.push(item);
}

/**
 * Run the single hunt search across all sources and return the consolidated new
 * finds. `hunts` is the active hunt list (the only source of scope). Readers are
 * injectable for tests. `scope` passes through to the site search ("all" runs every
 * site on Lloyd, who has the browser + eBay API + Brave).
 */
export async function runHuntSearch({
  hunts = [],
  scope = "all",
  siteRunner = runSavedSearches,
  boutiqueRunner = runBoutiqueFeeds,
  firstLookRunner = runFirstLookFeed,
} = {}) {
  if (!Array.isArray(hunts) || !hunts.length) return { newItems: [], counts: { site: 0, boutique: 0, firstlook: 0 } };
  const out = [];
  const seen = new Set();
  const counts = { site: 0, boutique: 0, firstlook: 0 };

  // Resale sites (honed to each hunt). One provider hiccup must not sink the rest.
  try {
    const runs = await siteRunner({ scope, searches: hunts, hone: true });
    for (const r of runs || []) {
      for (const h of r.newHits || []) {
        push(out, seen, { source: "site", label: r.label, title: h.title || "New listing", url: h.url, price: h.price ?? null });
        counts.site += 1;
      }
    }
  } catch { /* sources are best-effort; a failure just yields fewer finds */ }

  // Vintage / archive boutiques (already honed inside the reader).
  try {
    const feeds = await boutiqueRunner({ hunts });
    for (const f of feeds || []) {
      for (const it of f.newItems || []) {
        push(out, seen, { source: "boutique", label: f.name, title: it.name || "New listing", url: it.url || it.href, price: it.price ?? null });
        counts.boutique += 1;
      }
    }
  } catch { /* best-effort */ }

  // TheRealReal First Look member early access (already honed inside the reader).
  try {
    const fl = await firstLookRunner({ hunts });
    for (const it of fl?.newItems || []) {
      const title = [it.brand, it.item].filter(Boolean).join(" ") || "New listing";
      push(out, seen, { source: "firstlook", label: "First Look", title, url: it.url || it.href, price: it.price ?? null });
      counts.firstlook += 1;
    }
  } catch { /* best-effort */ }

  return { newItems: out, counts };
}

/** Human summary of the consolidated finds, grouped by source. Pure. */
export function formatHuntFinds(newItems, { max = 20 } = {}) {
  if (!newItems || !newItems.length) return "";
  const LABELS = { site: "Sites", boutique: "Boutiques", firstlook: "First Look" };
  const order = ["site", "boutique", "firstlook"];
  const shown = newItems.slice(0, max);
  const lines = [];
  for (const src of order) {
    const group = shown.filter((i) => i.source === src);
    if (!group.length) continue;
    lines.push(`${LABELS[src]}:`);
    for (const i of group) lines.push(`- ${i.title}${i.price != null ? ` ($${i.price})` : ""}\n  ${i.url}`);
  }
  if (newItems.length > max) lines.push(`...and ${newItems.length - max} more`);
  return lines.join("\n");
}
