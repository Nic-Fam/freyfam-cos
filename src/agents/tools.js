// Per-specialist tool registry. `runSpecialist` (orchestrator.js) used to hand the
// specialists an empty tool list, so they could talk but not act. This gives each
// one a scoped, side-effect-light toolset:
//   - every specialist: domain-scoped memory (recall/remember namespaced by agent)
//   - finance: analyze_transactions (pure spending analysis; never moves money)
//   - resale: saved-search registry (add/list/remove)
//   - dev:     change-proposal log (propose/list; never deploys)
//
// High-stakes effects (sending mail/SMS, purchases) stay with the chief of staff,
// which wraps them in the confirmation gate. Specialists surface; they do not send.

import { recall, remember } from "../memory.js";
import { analyzeTransactions } from "../finance.js";
import { addSavedSearch, listSavedSearches, removeSavedSearch } from "../saved-searches.js";
import { addProposal, listProposals } from "../proposals.js";

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

const REGISTRY = {
  finance: () => ({
    tools: [
      ...memoryTools(),
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
      analyze_transactions: async ({ transactions }) => JSON.stringify(analyzeTransactions(transactions)),
    },
  }),

  resale: () => ({
    tools: [
      ...memoryTools(),
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
      add_saved_search: async (input) => JSON.stringify(await addSavedSearch(input)),
      list_saved_searches: async () => JSON.stringify(await listSavedSearches()),
      remove_saved_search: async ({ id }) => ((await removeSavedSearch(id)) ? "removed" : "not found"),
    },
  }),

  dev: () => ({
    tools: [
      ...memoryTools(),
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
