// ===========================================================================
// Resolve a free-text grocery item ("milk", "paper towels") to the EXACT product
// the family actually buys, by matching against their store purchase history (the
// Ralphs "Buy It Again" list). This is the brain of the Alexa->grocery loop Phase 2:
// the family says vague things at the fridge; we order the specific product they
// always get, not a guess.
//
// Pure + dependency-free so it's fully testable without the browser. The history
// fetch (browser read of the Buy-Again page) feeds this; see grocery.js.
// ===========================================================================

// Drop noise that doesn't help identify a product: articles, sizes/units, packaging.
const STOP = new Set([
  "the", "a", "an", "of", "and", "with", "for", "some", "my", "our",
  "oz", "ounce", "ounces", "lb", "lbs", "ct", "count", "pack", "pk", "ea", "each",
  "gal", "gallon", "qt", "pint", "box", "bag", "bottle", "case", "size",
]);

/** Normalize to comparable tokens: lowercase, strip punctuation, drop stopwords, rough singularize. */
export function tokenize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9%\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t)) // drop bare counts/sizes (18, 12); keep "2%"
    .map((t) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)); // milks->milk, eggs->egg
}

/**
 * Score how well a history product matches the requested item, 0..1. Coverage of the
 * REQUEST's tokens by the product name is the core signal (the request is the query),
 * plus a bonus when the full request appears as a phrase in the product name. Pure.
 */
export function scoreMatch(item, productName) {
  const want = tokenize(item);
  if (!want.length) return 0;
  const have = new Set(tokenize(productName));
  const overlap = want.filter((t) => have.has(t)).length;
  if (!overlap) return 0;
  let score = overlap / want.length; // how many of the requested words the product covers
  const ni = String(item).toLowerCase().replace(/[^a-z0-9%\s]/g, " ").replace(/\s+/g, " ").trim();
  const np = String(productName).toLowerCase();
  if (ni && np.includes(ni)) score = Math.min(1, score + 0.3); // exact phrase present
  return score;
}

/**
 * Best history match for one item. history is [{name, id?, productUrl?, frequency?, lastBought?}].
 * Returns {item, matched|null, score, ambiguous}. Ties at the top score are broken by
 * purchase frequency then recency; if still tied among DIFFERENT products, it's flagged
 * `ambiguous` so the approval prompt can ask. Below `threshold` => no confident match.
 */
export function matchItemToHistory(item, history = [], { threshold = 0.5 } = {}) {
  const scored = (history || [])
    .map((p) => ({ p, s: scoreMatch(item, p.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.p.frequency || 0) - (a.p.frequency || 0) || String(b.p.lastBought || "").localeCompare(String(a.p.lastBought || "")));

  const best = scored[0];
  if (!best || best.s < threshold) return { item, matched: null, score: best ? best.s : 0, ambiguous: false };
  // Ambiguous only if another DISTINCT product ties on score AND on the freq/recency tiebreak.
  const rivals = scored.filter((x) => x.s === best.s && x.p.name !== best.p.name && (x.p.frequency || 0) === (best.p.frequency || 0));
  return { item, matched: best.p, score: best.s, ambiguous: rivals.length > 0 };
}

/** Resolve every gathered item against history. Returns the per-item resolutions. */
export function resolveAgainstHistory(items = [], history = [], opts = {}) {
  return (items || []).map((it) => {
    const name = typeof it === "string" ? it : it.item;
    return { ...(typeof it === "string" ? { item: it } : it), ...matchItemToHistory(name, history, opts) };
  });
}

/** Human summary of the resolution for the approval prompt. Pure. */
export function formatResolution(resolutions = []) {
  const matched = resolutions.filter((r) => r.matched);
  const unmatched = resolutions.filter((r) => !r.matched);
  const lines = [];
  for (const r of matched) {
    lines.push(`- ${r.item} -> ${r.matched.name}${r.ambiguous ? " (best guess; a couple of options matched)" : ""}`);
  }
  if (unmatched.length) {
    lines.push(`Not found in your purchase history (will need a pick at checkout): ${unmatched.map((r) => r.item).join(", ")}`);
  }
  return lines.join("\n");
}
