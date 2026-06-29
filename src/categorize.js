// Rule-based transaction categorization for the finance ingest. Bank/card alerts
// rarely carry a clean category, so we assign one from the merchant + the alert text
// at ingest time. First matching rule wins (put specific rules above broad ones).
//
// Two layers:
//   - BUILTIN_RULES (code): generic, no PII. A Zelle payment defaults to services.
//   - stored rules (data/category-rules.json, GITIGNORED): the family's specific
//     payees (cleaner, sitter, etc.) -> services, with a note of what the service is.
//     Kept out of git like the family directory; deployed as a data file.
// Stored rules are checked FIRST so a named payee gets its descriptive note before
// the generic Zelle catch-all. A rule may set `source` ("checking"/"credit") to only
// apply to that side - used to keep common first names (Lulu, Juan) from matching a
// card MERCHANT; they only match person-to-person checking payments.

import { randomUUID } from "node:crypto";
import { createCollection } from "./stores/collection.js";

const BUILTIN_RULES = [
  { pattern: "\\bzelle\\b", category: "services", note: null },
];

const col = () =>
  createCollection({ file: process.env.CATEGORY_RULES_PATH || "./data/category-rules.json", partition: "categoryrule" });

/** Add a family-specific category rule (stored, gitignored). `pattern` is a regex (case-insensitive). */
export async function addCategoryRule({ pattern, category, note = null, source = null } = {}) {
  if (!pattern || !category) throw new Error("pattern and category are required");
  try { new RegExp(pattern, "i"); } catch { throw new Error("pattern is not a valid regular expression"); }
  const item = {
    id: randomUUID().slice(0, 8),
    pattern: String(pattern),
    category: String(category),
    note: note ? String(note) : null,
    source: source === "checking" || source === "credit" ? source : null,
    at: new Date().toISOString(),
  };
  await col().add(item);
  return item;
}

export async function listCategoryRules() {
  return col().list();
}

/** Stored family rules first, then builtin generic rules. */
export async function loadCategoryRules() {
  return [...(await listCategoryRules()), ...BUILTIN_RULES];
}

/**
 * Categorize from merchant + surrounding alert text. `rules` defaults to the builtin
 * set; pass loadCategoryRules() to include the family's stored payees. A rule scoped
 * to a `source` only applies to that side. Returns {category, note} or null.
 */
export function categorize({ merchant = "", text = "", source } = {}, rules = BUILTIN_RULES) {
  const hay = `${merchant || ""} ${text || ""}`;
  for (const r of rules) {
    if (r.source && source && r.source !== source) continue;
    let re;
    try { re = new RegExp(r.pattern, "i"); } catch { continue; }
    if (re.test(hay)) return { category: r.category, note: r.note || null };
  }
  return null;
}
