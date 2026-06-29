// Rule-based transaction categorization for the finance ingest. Bank/card alerts
// rarely carry a clean category, so we assign one from the merchant + the alert text
// at ingest time. Deterministic and ordered: the FIRST matching rule wins, so put
// more specific rules above broader ones. Surfacing only; categories just group
// spend in the reports/analysis.
//
// Today: Zelle payments -> "services" (the family pays cleaners, sitters, and
// contractors by Zelle, and wants them rolled up as services). Add rules here as
// new patterns come up.

export const CATEGORY_RULES = [
  { match: /\bzelle\b/i, category: "services" },
];

/**
 * Return a category for a transaction from its merchant + surrounding alert text,
 * or null if no rule matches (the caller leaves it uncategorized).
 * @param {{merchant?:string, text?:string}} input
 */
export function categorize({ merchant = "", text = "" } = {}) {
  const hay = `${merchant || ""} ${text || ""}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(hay)) return rule.category;
  }
  return null;
}
