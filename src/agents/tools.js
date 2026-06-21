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
import { analyzeTransactions } from "../finance.js";
import { addSavedSearch, listSavedSearches, removeSavedSearch } from "../saved-searches.js";
import { addProposal, listProposals } from "../proposals.js";
import {
  getMealsInRange, saveMeal, deleteMeal, formatMealsContext,
  listActive, summary, getExpiringSoon, addItem, consume,
} from "../meals.js";
import { addFinding, listFindings, SECURITY_SEVERITIES } from "../security.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });

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
      analyze_transactions: async ({ transactions }) => JSON.stringify(analyzeTransactions(transactions)),
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
    ],
    handlers: {
      ...memoryHandlers("resale"),
      ...decisionHandlers("resale"),
      ...searchHandler(),
      add_saved_search: async (input) => JSON.stringify(await addSavedSearch(input)),
      list_saved_searches: async () => JSON.stringify(await listSavedSearches()),
      remove_saved_search: async ({ id }) => ((await removeSavedSearch(id)) ? "removed" : "not found"),
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
    ],
    handlers: {
      ...memoryHandlers("chef"),
      ...decisionHandlers("chef"),
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
      expiring_soon: async ({ days } = {}) => JSON.stringify(await getExpiringSoon(days ?? 4)),
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
    ],
    handlers: {
      ...memoryHandlers("security"),
      ...decisionHandlers("security"),
      ...searchHandler(),
      log_security_finding: async (input) => JSON.stringify(await addFinding(input)),
      list_security_findings: async () => JSON.stringify(await listFindings()),
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

/** Return { tools, handlers } for a specialist, or empty sets for an unknown agent. */
export function specialistTools(agent) {
  const make = REGISTRY[agent];
  return make ? make() : { tools: [], handlers: {} };
}
