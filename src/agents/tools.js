// Per-specialist tool registry. `runSpecialist` (orchestrator.js) used to hand the
// specialists an empty tool list, so they could talk but not act. This gives each
// one a scoped, side-effect-light toolset:
//   - every specialist: domain-scoped memory (recall/remember namespaced by agent)
//                       + a per-agent decision log (log/list, the Genet decision.md)
//   - finance: analyze_transactions (pure spending analysis; never moves money)
//   - resale: saved-search registry (add/list/remove)
//   - dev:     change-proposal log (propose/list; never deploys)
//
// High-stakes effects (sending mail/SMS, purchases) stay with the chief of staff,
// which wraps them in the confirmation gate. Specialists surface; they do not send.

import { recall, remember } from "../memory.js";
import { logDecision, listDecisions } from "../decisions.js";
import { webSearch } from "../search.js";
import { addShoppingItem, listShopping, formatShopping } from "../shopping.js";
import { analyzeTransactions, detectRecurring } from "../finance.js";
import { useItUpSuggestion } from "../meals.js";
import { addSavedSearch, listSavedSearches, removeSavedSearch, runSavedSearches, formatSavedSearchRun } from "../saved-searches.js";
import { addProposal, listProposals } from "../proposals.js";
import {
  getMealsInRange, saveMeal, deleteMeal, formatMealsContext,
  listActive, summary, getExpiringSoon, addItem, consume,
} from "../meals.js";
import { addFinding, listFindings, SECURITY_SEVERITIES } from "../security.js";
import { securityPosture } from "../security-monitor.js";
import { createLogger } from "../log.js";

const log = createLogger("agent-tools");

const obj = (properties, required = []) => ({ type: "object", properties, required });

// === Per-agent tool allowlist: the enforced SECURITY BOUNDARY (workstream K#4) ==
// Each specialist may use EXACTLY the tools listed here, nothing more. This is the
// source of truth; the REGISTRY below builds the tool DEFS/handlers, and
// specialistTools() FILTERS what the registry produces down to this allowlist
// (failing CLOSED), logging loudly if the registry ever drifts outside it. So a
// future edit that wires a powerful tool into a specialist cannot silently widen its
// scope. A channel/persona cannot widen it either: the runner only ever assembles
// tools via specialistTools(), and a per-agent channel routes through delegate ->
// runSpecialist (the scoped path), never the chief's full toolset.
const COMMON_TOOLS = ["recall_memory", "remember", "log_decision", "list_decisions"];
export const AGENT_ALLOWLIST = {
  finance: [...COMMON_TOOLS, "analyze_transactions"], // NO search/browse/outbound — finance stays locked down
  resale: [...COMMON_TOOLS, "search", "add_saved_search", "list_saved_searches", "remove_saved_search", "run_saved_searches"],
  chef: [...COMMON_TOOLS, "view_meal_plan", "plan_meal", "remove_meal", "kitchen_inventory", "inventory_summary", "expiring_soon", "add_inventory_item", "consume_inventory_item", "add_shopping_item", "list_shopping"],
  security: [...COMMON_TOOLS, "search", "log_security_finding", "list_security_findings", "security_posture"],
  dev: [...COMMON_TOOLS, "propose_change", "list_proposals"],
};

// Tools that act on the family's behalf or move the world. These live ONLY on the
// chief (Lloyd), behind the confirmation gate. A specialist may NEVER hold one,
// regardless of any allowlist edit — specialistTools() throws if an allowlist
// contains one, making hard constraint #2 (human-in-the-loop for all outbound)
// executable rather than just convention. Names mirror the chief's tool list in
// orchestrator.js; a couple of not-yet-built outbound names are included defensively.
export const CHIEF_ONLY_TOOLS = new Set([
  "delegate", // only the chief delegates; a specialist delegating would break isolation
  "send_email", "send_sms", "send_imessage", "reply_email", "reply_to_message",
  "place_order", "run_grocery_order", "create_calendar_event",
]);

// Memory tools, scoped to the calling agent so finance memories don't pollute
// resale recall and vice versa.
function memoryTools() {
  return [
    { name: "recall_memory", description: "Search your domain's long-term memory.", input_schema: obj({ query: { type: "string" } }, ["query"]) },
    { name: "remember", description: "Save a durable fact or preference to your domain's memory.", input_schema: obj({ text: { type: "string" } }, ["text"]) },
  ];
}
function memoryHandlers(agent) {
  return {
    recall_memory: async ({ query }) => JSON.stringify(await recall(query, 5, { agent })),
    remember: async ({ text }) => {
      await remember(text, { agent });
      return "saved";
    },
  };
}

// Decision-log tools (the Genet "decision.md" pattern), scoped to the calling
// agent. Separate from memory: this is the durable record of *final decisions*
// the specialist made, for a human to audit later. Logging a decision takes no
// real-world action - high-stakes effects still go through the chief's gate.
function decisionTools() {
  return [
    {
      name: "log_decision",
      description: "Record a final decision you reached, with a short why, to your durable decision log. Does not take any real-world action.",
      input_schema: obj({
        title: { type: "string" },
        decision: { type: "string" },
        rationale: { type: "string" },
        context: { type: "string" },
      }, ["title", "decision"]),
    },
    { name: "list_decisions", description: "List your recent recorded decisions, newest first.", input_schema: obj({}) },
  ];
}
function decisionHandlers(agent) {
  return {
    log_decision: async (input) => JSON.stringify(await logDecision(agent, input)),
    list_decisions: async () => JSON.stringify(await listDecisions(agent)),
  };
}

// Read-only web search (workstream N). Granted PER AGENT: resale needs it most
// (hunting listings/comps), security gets it for threat-intel lookups. NOT
// granted to finance (kept locked down) — exclusion is by omission. Returns
// [{title, url, snippet}] so the agent can pick a URL to browse next.
export const searchToolDef = {
  name: "search",
  description:
    "Search the web (read-only) and get back ranked results as {title, url, snippet}. Use it to find URLs/facts/listings; then read the best hit with browse_page. Acting on a result (buy/email) still requires the chief's confirmation.",
  input_schema: obj({ query: { type: "string" }, count: { type: "number" } }, ["query"]),
};
export function searchHandler() {
  return {
    search: async ({ query, count }) => {
      try {
        const results = await webSearch(query, count ? { count } : {});
        return results.length ? JSON.stringify(results) : "No results.";
      } catch (e) {
        return `Could not search: ${e.message}`;
      }
    },
  };
}

const REGISTRY = {
  finance: () => ({
    tools: [
      ...memoryTools(),
      ...decisionTools(),
      {
        name: "analyze_transactions",
        description: "Summarize a list of transactions: totals by category, duplicate charges, and notable price jumps. Does not move money.",
        input_schema: obj({
          transactions: {
            type: "array",
            items: obj(
              { date: { type: "string" }, amount: { type: "number" }, merchant: { type: "string" }, category: { type: "string" } },
              ["amount"]
            ),
          },
        }, ["transactions"]),
      },
    ],
    handlers: {
      ...memoryHandlers("finance"),
      ...decisionHandlers("finance"),
      analyze_transactions: async ({ transactions }) =>
        JSON.stringify({ ...analyzeTransactions(transactions), recurring: detectRecurring(transactions) }),
    },
  }),

  resale: () => ({
    tools: [
      ...memoryTools(),
      ...decisionTools(),
      searchToolDef,
      {
        name: "add_saved_search",
        description: "Register a designer piece to hunt across resale sites.",
        input_schema: obj({
          query: { type: "string" },
          label: { type: "string" },
          maxPrice: { type: "number" },
          sites: { type: "array", items: { type: "string" } },
        }, ["query"]),
      },
      { name: "list_saved_searches", description: "List the family's active saved searches.", input_schema: obj({}) },
      { name: "remove_saved_search", description: "Remove a saved search by its id.", input_schema: obj({ id: { type: "string" } }, ["id"]) },
      {
        name: "run_saved_searches",
        description: "Run ALL saved searches now and report only the NEW matches since last time (past hits are tracked and not repeated). Use to check for fresh finds across the hunt list.",
        input_schema: obj({}),
      },
    ],
    handlers: {
      ...memoryHandlers("resale"),
      ...decisionHandlers("resale"),
      ...searchHandler(),
      add_saved_search: async (input) => JSON.stringify(await addSavedSearch(input)),
      list_saved_searches: async () => JSON.stringify(await listSavedSearches()),
      remove_saved_search: async ({ id }) => ((await removeSavedSearch(id)) ? "removed" : "not found"),
      run_saved_searches: async () => formatSavedSearchRun(await runSavedSearches()),
    },
  }),

  chef: () => ({
    tools: [
      ...memoryTools(),
      ...decisionTools(),
      {
        name: "view_meal_plan",
        description: "Show planned meals between two dates (inclusive, YYYY-MM-DD).",
        input_schema: obj({ startDate: { type: "string" }, endDate: { type: "string" } }, ["startDate", "endDate"]),
      },
      {
        name: "plan_meal",
        description: "Add or replace a planned meal for a date and meal type.",
        input_schema: obj({
          date: { type: "string" },
          mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
          name: { type: "string" },
          prepMinutes: { type: "number" },
          notes: { type: "string" },
          recipeUrl: { type: "string" },
        }, ["date", "mealType", "name"]),
      },
      {
        name: "remove_meal",
        description: "Remove a planned meal for a date and meal type.",
        input_schema: obj({
          date: { type: "string" },
          mealType: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
        }, ["date", "mealType"]),
      },
      {
        name: "kitchen_inventory",
        description: "List items currently in the kitchen, optionally filtered.",
        input_schema: obj({
          location: { type: "string", enum: ["fridge", "freezer", "pantry", "counter", "other"] },
          category: { type: "string" },
          query: { type: "string" },
        }),
      },
      { name: "inventory_summary", description: "Counts by category plus expiring-soon and recently-added shortlists.", input_schema: obj({}) },
      { name: "expiring_soon", description: "Items expiring within N days (default 4); includes already-expired.", input_schema: obj({ days: { type: "number" } }) },
      {
        name: "add_inventory_item",
        description: "Add an item to the kitchen inventory. Expiration is estimated if not given.",
        input_schema: obj({
          name: { type: "string" },
          category: { type: "string", enum: ["produce", "dairy", "meat", "pantry", "frozen", "bakery", "beverage", "condiment", "snack", "other"] },
          location: { type: "string", enum: ["fridge", "freezer", "pantry", "counter", "other"] },
          quantity: { type: "number" },
          unit: { type: "string" },
          expiresAt: { type: "string" },
          opened: { type: "boolean" },
          notes: { type: "string" },
        }, ["name"]),
      },
      {
        name: "consume_inventory_item",
        description: "Mark some/all of an inventory item used. Omit quantity to use it all.",
        input_schema: obj({ id: { type: "string" }, quantity: { type: "number" } }, ["id"]),
      },
      {
        name: "add_shopping_item",
        description: "Add an item to the family shopping list (e.g. something low or expiring that needs restocking). Optional quantity/note. Does NOT order anything — it's for the family to review.",
        input_schema: obj({ item: { type: "string" }, quantity: { type: "string" }, note: { type: "string" } }, ["item"]),
      },
      { name: "list_shopping", description: "Show the current family shopping list.", input_schema: obj({}) },
    ],
    handlers: {
      ...memoryHandlers("chef"),
      ...decisionHandlers("chef"),
      add_shopping_item: async ({ item, quantity, note }) => {
        const { item: it, merged } = await addShoppingItem({ item, quantity, note, addedBy: "carmine" });
        return `${merged ? "Updated" : "Added"} on the shopping list: ${it.item}`;
      },
      list_shopping: async () => formatShopping(await listShopping()),
      view_meal_plan: async ({ startDate, endDate }) => {
        const meals = await getMealsInRange(startDate, endDate);
        return formatMealsContext(meals) || "No meals planned in that range.";
      },
      plan_meal: async (input) => JSON.stringify(await saveMeal({ ...input, createdBy: "carmine" })),
      remove_meal: async ({ date, mealType }) => {
        await deleteMeal(date, mealType);
        return "removed";
      },
      kitchen_inventory: async (filter) => JSON.stringify(await listActive(filter || {})),
      inventory_summary: async () => JSON.stringify(await summary()),
      expiring_soon: async ({ days } = {}) => {
        const items = await getExpiringSoon(days ?? 4);
        // #5 use-it-up: hand Carmine a ready nudge so he proactively suggests a meal
        // to use the soonest-expiring items, not just lists them.
        return JSON.stringify({ items, useItUp: useItUpSuggestion(items) });
      },
      add_inventory_item: async (input) => JSON.stringify(await addItem({ ...input, addedBy: "carmine", source: "manual" })),
      consume_inventory_item: async ({ id, quantity }) => {
        const r = await consume(id, { quantity, actor: "carmine" });
        return r ? JSON.stringify(r) : "item fully consumed and removed";
      },
    },
  }),

  security: () => ({
    tools: [
      ...memoryTools(),
      ...decisionTools(),
      searchToolDef,
      {
        name: "log_security_finding",
        description: "Record a security finding/advisory for a human to review. Read-only: does NOT take any control action (no arm/disarm, lock, or credential change).",
        input_schema: obj({
          title: { type: "string" },
          severity: { type: "string", enum: SECURITY_SEVERITIES },
          summary: { type: "string" },
          recommendation: { type: "string" },
        }, ["title"]),
      },
      { name: "list_security_findings", description: "List recorded security findings.", input_schema: obj({}) },
      { name: "security_posture", description: "Summarize the OPEN security findings worst-first (counts by severity + what needs attention). Use for 'how's our security?' / a posture check. Read-only.", input_schema: obj({}) },
    ],
    handlers: {
      ...memoryHandlers("security"),
      ...decisionHandlers("security"),
      ...searchHandler(),
      log_security_finding: async (input) => JSON.stringify(await addFinding(input)),
      list_security_findings: async () => JSON.stringify(await listFindings()),
      security_posture: async () => securityPosture(await listFindings()),
    },
  }),

  dev: () => ({
    tools: [
      ...memoryTools(),
      ...decisionTools(),
      {
        name: "propose_change",
        description: "Record a change proposal (plan/diff) for a human to review and run. Does NOT deploy anything.",
        input_schema: obj({
          title: { type: "string" },
          rationale: { type: "string" },
          steps: { type: "array", items: { type: "string" } },
        }, ["title"]),
      },
      { name: "list_proposals", description: "List recorded change proposals.", input_schema: obj({}) },
    ],
    handlers: {
      ...memoryHandlers("dev"),
      ...decisionHandlers("dev"),
      propose_change: async (input) => JSON.stringify(await addProposal(input)),
      list_proposals: async () => JSON.stringify(await listProposals()),
    },
  }),
};

/**
 * Return { tools, handlers } for a specialist, ENFORCED against the agent's
 * allowlist. The allowlist is the boundary: anything the registry produces that
 * is not on it is dropped (fail closed) and logged, so a specialist can never
 * exceed its declared scope even if the registry drifts. An allowlist that names a
 * chief-only (outbound/high-stakes) tool is a hard misconfiguration and throws.
 * Unknown agent -> empty sets (no tools).
 */
// Progressive trust (the Genet "limited access first, expanded as it proves out"
// principle). An agent may be temporarily narrowed to a SUBSET of its allowlist while
// it earns trust: `COS_TRUST_<AGENT>` (comma-separated tool names) enables ONLY those,
// plus the always-on memory/decision baseline (so even the lowest-trust agent can
// observe + remember, never act beyond scope). UNSET => the full allowlist (default,
// no restriction). Set it empty (e.g. COS_TRUST_DEV=) for baseline-only "observe" mode.
// This NARROWS the K#4 allowlist; it can never widen past it. Pure (env-driven).
export function trustedTools(agent, allow) {
  const raw = process.env[`COS_TRUST_${String(agent).toUpperCase()}`];
  if (raw === undefined) return new Set(allow); // not configured -> full allowlist
  const enabled = new Set([...COMMON_TOOLS, ...raw.split(",").map((s) => s.trim()).filter(Boolean)]);
  return new Set([...allow].filter((t) => enabled.has(t)));
}

export function specialistTools(agent) {
  const make = REGISTRY[agent];
  if (!make) return { tools: [], handlers: {} };

  const allow = new Set(AGENT_ALLOWLIST[agent] || []);
  // Hard invariant: no specialist allowlist may include a chief-only tool. This is
  // the human-in-the-loop / no-outbound constraint made executable. Allowlists are
  // static constants, so a clean config never trips this; a bad edit fails loudly.
  for (const name of allow) {
    if (CHIEF_ONLY_TOOLS.has(name)) {
      throw new Error(`Tool allowlist for "${agent}" contains chief-only tool "${name}": specialists never send or spend.`);
    }
  }
  // Progressive trust narrows (never widens) the allowlist for what's CURRENTLY enabled.
  const trusted = trustedTools(agent, allow);

  const { tools, handlers } = make();
  // Fail CLOSED on registry DRIFT: a tool the registry produced that isn't even in the
  // allowlist is a bug -> drop + log error (distinct from an intentional trust restriction).
  const drift = tools.map((t) => t.name).filter((n) => !allow.has(n));
  if (drift.length) log.error("blocked out-of-allowlist tools", { agent, dropped: drift });

  // Keep only TRUSTED tools/handlers (allowlisted AND currently enabled by trust level).
  const keptTools = tools.filter((t) => trusted.has(t.name));
  const keptHandlers = {};
  for (const [name, fn] of Object.entries(handlers)) {
    if (trusted.has(name)) keptHandlers[name] = fn;
  }
  return { tools: keptTools, handlers: keptHandlers };
}
