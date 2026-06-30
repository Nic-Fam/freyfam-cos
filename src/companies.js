import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ===========================================================================
// COO roster loader (TRACKER workstream S, step 1; org shape in ORG_STRUCTURE.md).
//
// The COO tier is DATA-DRIVEN: data/companies.json is the single source of truth
// for which companies exist, each company's own specialist tier, its budget, and
// which SHARED family specialists its COO may request. Adding a company is an
// entry in that file plus nothing else - personas render from two templates
// (agents/coo.template.md, agents/company-specialist.template.md), and the tool
// allowlist / registry wiring (agents/tools.js) reads this roster to register
// each company agent with a scoped, side-effect-light toolset.
//
// Agent keys are DERIVED so they are stable and collision-safe:
//   COO:                <companyKey>-coo            e.g. sasshey-coo
//   company specialist: <companyKey>-<role-slug>    e.g. dariviant-community-intelligence
//
// HARD CONSTRAINT preserved by construction: a COO and a company specialist are
// shaped exactly like a household specialist - own persona, scoped memory +
// decision log, an allowlist that can NEVER contain a CHIEF_ONLY_TOOLS entry
// (agents/tools.js enforces it). They surface plans/insight and (step 2) emit
// requests; Lloyd holds every outbound channel and the confirmation gate.
// ===========================================================================

const __dir = dirname(fileURLToPath(import.meta.url));

// The shared, freyfam-level specialists a COO is allowed to request through Lloyd.
// allowedSpecialists in the roster must be a subset of these. chef/security are
// household-only and intentionally excluded from the company surface.
export const FAMILY_SPECIALISTS = ["finance", "dev", "resale", "chef", "security"];

// Agent keys a company entry may NOT collide with (the host + household roster).
const RESERVED_KEYS = new Set([...FAMILY_SPECIALISTS, "chief", "chief-of-staff"]);

// Friendlier labels for the family specialists, used only when rendering a COO
// persona's "specialists you can request" line. Falls back to the bare key.
const FAMILY_LABELS = { finance: "finance (Patrick)", dev: "dev (Steve)", resale: "resale (Shey)" };

/** kebab-case a role into a filename/agent-key-safe slug. */
function slug(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Validate + normalize parsed roster JSON into the derived shape the rest of the
 * system consumes. PURE (no I/O), so it is unit-testable with inline objects.
 * Throws loudly on a bad config - a malformed roster should fail at boot, not
 * silently register a broken agent.
 *
 * @param {{companies?: object[]}} raw parsed companies.json
 * @returns {{companies: object[], coos: object[], companySpecialists: object[], byAgent: Map<string, object>}}
 */
export function normalizeCompanies(raw) {
  const list = Array.isArray(raw?.companies) ? raw.companies : null;
  if (!list) throw new Error("companies.json: expected a top-level { companies: [...] } array");

  const byAgent = new Map();
  const seenCompanyKeys = new Set();
  const companies = [];

  for (const entry of list) {
    const key = String(entry?.key || "").trim().toLowerCase();
    if (!/^[a-z0-9]+$/.test(key)) {
      throw new Error(`companies.json: company key ${JSON.stringify(entry?.key)} must be lowercase alphanumeric`);
    }
    if (RESERVED_KEYS.has(key)) throw new Error(`companies.json: company key "${key}" is reserved`);
    if (seenCompanyKeys.has(key)) throw new Error(`companies.json: duplicate company key "${key}"`);
    seenCompanyKeys.add(key);

    const company = String(entry?.company || "").trim();
    const business = String(entry?.business || "").trim();
    if (!company) throw new Error(`companies.json: company "${key}" is missing a display name ("company")`);
    if (!business) throw new Error(`companies.json: company "${key}" is missing "business"`);

    const budgetUsd = Number(entry?.budgetUsd);
    if (!(budgetUsd > 0)) throw new Error(`companies.json: company "${key}" needs a positive budgetUsd`);
    const cycle = String(entry?.cycle || "monthly").trim().toLowerCase();

    const allowedSpecialists = Array.isArray(entry?.allowedSpecialists) ? entry.allowedSpecialists.map((s) => String(s).trim().toLowerCase()) : [];
    for (const s of allowedSpecialists) {
      if (!FAMILY_SPECIALISTS.includes(s)) {
        throw new Error(`companies.json: company "${key}" allowedSpecialists has unknown family specialist "${s}" (expected one of: ${FAMILY_SPECIALISTS.join(", ")})`);
      }
    }

    const cooKey = `${key}-coo`;
    if (byAgent.has(cooKey)) throw new Error(`companies.json: derived COO key "${cooKey}" collides with another agent`);

    const specEntries = Array.isArray(entry?.specialists) ? entry.specialists : [];
    const specialists = [];
    const seenSlugs = new Set();
    for (const sp of specEntries) {
      const role = String(sp?.role || "").trim();
      if (!role) throw new Error(`companies.json: a specialist of "${key}" is missing "role"`);
      const sl = slug(role);
      if (!sl) throw new Error(`companies.json: specialist role ${JSON.stringify(role)} of "${key}" produced an empty slug`);
      if (seenSlugs.has(sl)) throw new Error(`companies.json: company "${key}" has two specialists slugging to "${sl}"`);
      seenSlugs.add(sl);
      const sKey = `${key}-${sl}`;
      if (byAgent.has(sKey) || RESERVED_KEYS.has(sKey)) {
        throw new Error(`companies.json: derived specialist key "${sKey}" collides with another agent`);
      }
      const specialist = { key: sKey, slug: sl, role, focus: String(sp?.focus || "").trim(), companyKey: key, company, cooKey };
      specialists.push(specialist);
      byAgent.set(sKey, { type: "specialist", ...specialist });
    }

    const normalized = { key, company, business, goal: String(entry?.goal || "").trim(), budgetUsd, cycle, allowedSpecialists, cooKey, specialists };
    companies.push(normalized);
    byAgent.set(cooKey, { type: "coo", key: cooKey, companyKey: key, company, business, goal: normalized.goal, budgetUsd, cycle, allowedSpecialists, specialists });
  }

  const coos = companies.map((c) => byAgent.get(c.cooKey));
  const companySpecialists = companies.flatMap((c) => c.specialists.map((s) => byAgent.get(s.key)));
  return { companies, coos, companySpecialists, byAgent };
}

// --- Memoized load of the real roster file (read once; reset for tests). -------

const COMPANIES_PATH = () => process.env.COMPANIES_PATH || "./data/companies.json";
let _roster = null;

/** Load + normalize the roster, memoized. Empty roster if the file is absent. */
export function loadRoster() {
  if (_roster) return _roster;
  let raw;
  try {
    raw = JSON.parse(readFileSync(COMPANIES_PATH(), "utf8"));
  } catch (e) {
    // No roster file yet (e.g. a fresh checkout before companies are defined) is
    // a valid empty state, not an error. A PRESENT-but-malformed file still throws
    // via normalizeCompanies below, so a typo fails loudly.
    if (e?.code === "ENOENT") {
      _roster = normalizeCompanies({ companies: [] });
      return _roster;
    }
    throw e;
  }
  _roster = normalizeCompanies(raw);
  return _roster;
}

/** Test hook: drop the memoized roster + persona-template cache. */
export function _resetForTest() {
  _roster = null;
  _templateCache.clear();
}

export function cooRoster() { return loadRoster().coos; }
export function companySpecialistRoster() { return loadRoster().companySpecialists; }
/** Every COO + company-specialist agent key (does NOT include family agents). */
export function companyAgentKeys() { return [...loadRoster().byAgent.keys()]; }
export function companyAgent(agentKey) { return loadRoster().byAgent.get(agentKey) || null; }
export function isCompanyAgent(agentKey) { return loadRoster().byAgent.has(agentKey); }
export function isCoo(agentKey) { return companyAgent(agentKey)?.type === "coo"; }

// --- Persona rendering from the two templates. --------------------------------

const _templateCache = new Map();
function template(name) {
  if (_templateCache.has(name)) return _templateCache.get(name);
  const text = readFileSync(join(__dir, "agents", `${name}.template.md`), "utf8");
  _templateCache.set(name, text);
  return text;
}
function fill(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
}

/**
 * Render the persona text for a company agent (COO or company specialist), or
 * null if the key is not a company agent (so persona.js falls back to a .md file).
 */
export function renderCompanyPersona(agentKey) {
  const a = companyAgent(agentKey);
  if (!a) return null;
  if (a.type === "coo") {
    const specialistLines = a.specialists.length
      ? a.specialists.map((s) => `- ${s.role}: ${s.focus}`).join("\n")
      : "- (no company specialists defined yet)";
    const familyLine = a.allowedSpecialists.map((s) => FAMILY_LABELS[s] || s).join(", ") || "(none configured)";
    return fill(template("coo"), {
      COMPANY: a.company,
      BUSINESS: a.business,
      GOAL: a.goal || "(not yet defined)",
      COMPANY_SPECIALISTS: specialistLines,
      FAMILY_SPECIALISTS: familyLine,
      BUDGET: `$${a.budgetUsd} per ${a.cycle} cycle`,
    });
  }
  return fill(template("company-specialist"), {
    COMPANY: a.company,
    ROLE: a.role,
    FOCUS: a.focus || "(focus not yet specified)",
    COO: `the ${a.company} COO`,
  });
}
