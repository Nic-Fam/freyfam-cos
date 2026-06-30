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
import { logTransaction, listTransactions, summarizeSpend, formatSpend, runningTab, formatRunningTab, recurringCheckingWithdrawals, formatRecurringWithdrawals } from "../finance-log.js";
import { reconcile, formatReconciliation } from "../reconcile.js";
import { useItUpSuggestion } from "../meals.js";
import { addSavedSearch, listSavedSearches, removeSavedSearch, runSavedSearches, formatSavedSearchRun, formatSavedSearchList } from "../saved-searches.js";
import { addObligation, listObligations, removeObligation, planCheckingTransfer, formatObligations, monthlyConsumption, formatConsumption } from "../obligations.js";
import { transferOutlook } from "../transfer-outlook.js";
import { readTrrReturns, reconcileTrrReturns } from "../resale-returns.js";
import { setCheckingAnchor } from "../checking-balance.js";
import { setStatement } from "../credit-statement.js";
import { addCategoryRule } from "../categorize.js";
import { addProposal, listProposals } from "../proposals.js";
import {
  getMealsInRange, saveMeal, deleteMeal, formatMealsContext,
  listActive, summary, getExpiringSoon, addItem, consume,
} from "../meals.js";
import { addFinding, listFindings, SECURITY_SEVERITIES } from "../security.js";
import { securityPosture } from "../security-monitor.js";
import { cooRoster, companySpecialistRoster } from "../companies.js";
import { requestToolDefs, requestHandlers, REQUEST_TOOL_NAMES } from "../coo-requests.js";
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
  // NO search/browse/outbound — finance stays locked down. All read/log/compute only.
  finance: [...COMMON_TOOLS, "analyze_transactions", "log_transaction", "list_transactions", "spending_summary",
            "plan_checking_transfer", "set_obligation", "list_obligations", "remove_obligation",
            "running_tab", "reconcile_statement", "transfer_outlook", "set_checking_balance", "set_credit_statement",
            "add_category_rule", "monthly_consumption", "recurring_withdrawals", "reconcile_returns"],
  resale: [...COMMON_TOOLS, "search", "add_saved_search", "list_saved_searches", "remove_saved_search", "run_saved_searches", "export_saved_searches", "check_returns"],
  chef: [...COMMON_TOOLS, "view_meal_plan", "plan_meal", "remove_meal", "kitchen_inventory", "inventory_summary", "expiring_soon", "add_inventory_item", "consume_inventory_item", "add_shopping_item", "list_shopping"],
  security: [...COMMON_TOOLS, "search", "log_security_finding", "list_security_findings", "security_posture"],
  dev: [...COMMON_TOOLS, "propose_change", "list_proposals"],
};

// === COO tier (workstream S). Company agents are data-driven (data/companies.json),
// so their allowlists are registered here from the roster rather than hardcoded. A
// COO manages a company: it gets the memory/decision baseline plus read-only web
// search for market/community research. A company specialist owns operational data
// and reports up: baseline only for now (its role-specific tools land in step 6).
// NEITHER may ever hold a CHIEF_ONLY_TOOLS entry - specialistTools() throws if one
// does, the same executable guard as for the household specialists. The request seam
// (request_specialist / request_heavy_lift / request_action, step 2) is a COO-only
// surface: a COO emits requests that Lloyd fulfills behind his gate. Company
// specialists report up to their COO, so they get the baseline only (their
// role-specific tools land in step 6). None of these are CHIEF_ONLY.
const COO_TOOLS = [...COMMON_TOOLS, "search", ...REQUEST_TOOL_NAMES];
const COMPANY_SPECIALIST_TOOLS = [...COMMON_TOOLS];
for (const c of cooRoster()) AGENT_ALLOWLIST[c.key] = COO_TOOLS;
for (const s of companySpecialistRoster()) AGENT_ALLOWLIST[s.key] = COMPANY_SPECIALIST_TOOLS;

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
      {
        name: "log_transaction",
        description: "Record ONE transaction from a forwarded bank/card alert into the running spend log. Do this for each transaction alert you see. Logging only; never moves money.",
        input_schema: obj({
          amount: { type: "number" },
          date: { type: "string" },
          merchant: { type: "string" },
          card: { type: "string" },
          category: { type: "string" },
          note: { type: "string" },
        }, ["amount"]),
      },
      {
        name: "list_transactions",
        description: "List logged transactions, newest first. Optionally filter by recency window (sinceDays), card, or merchant.",
        input_schema: obj({
          sinceDays: { type: "number" },
          card: { type: "string" },
          merchant: { type: "string" },
        }),
      },
      {
        name: "spending_summary",
        description: "Roll up the logged transactions over the last `sinceDays` (default 7): total, totals by category, duplicate charges, notable price jumps, and recurring-charge radar.",
        input_schema: obj({ sinceDays: { type: "number" } }),
      },
      {
        name: "plan_checking_transfer",
        description:
          "Compute how much to transfer INTO joint checking to keep at least a buffer (default $1000) at every point through the upcoming bills. Reads the recorded checking obligations (rent, car payment, weekly BrightHorizons, etc.) and projects the running balance, protecting the LOWEST point, not just the ending balance. Always pass the current checking balance. For a variable bill like the credit card payment, pass `creditCardPayment` (or `amounts`). Surfacing only; never moves money.",
        input_schema: obj({
          currentBalance: { type: "number" },
          buffer: { type: "number" },
          creditCardPayment: { type: "number" },
          throughDate: { type: "string" },
          horizonDays: { type: "number" },
          amounts: { type: "object" },
          extraOutflows: { type: "array", items: obj({ name: { type: "string" }, amount: { type: "number" }, date: { type: "string" } }, ["amount", "date"]) },
          expectedInflows: { type: "array", items: obj({ name: { type: "string" }, amount: { type: "number" }, date: { type: "string" } }, ["amount", "date"]) },
        }, ["currentBalance"]),
      },
      {
        name: "set_obligation",
        description:
          "Record or update a recurring flow. cadence monthly (dueDay 1-31; use 31 for end of month), weekly (dueWeekday 0=Sun..6=Sat), biweekly (anchorDate YYYY-MM-DD; every 14 days), interval (intervalDays + anchorDate, e.g. every 21 days for a 3-week nail cycle), or once (date). direction 'out' for a bill (default) or 'in' for income. account 'joint' (default; affects the transfer floor) or another label like 'shelli' for household income that funds her transfer but does NOT land in joint (counts in consumption, not the floor). variable:true for an amount that changes each cycle (credit card). Use note for cash items (nails, trash) that only show as cash withdrawals.",
        input_schema: obj({
          name: { type: "string" },
          amount: { type: "number" },
          cadence: { type: "string", enum: ["monthly", "weekly", "biweekly", "interval", "once"] },
          dueDay: { type: "number" },
          dueWeekday: { type: "number" },
          anchorDate: { type: "string" },
          intervalDays: { type: "number" },
          date: { type: "string" },
          direction: { type: "string", enum: ["out", "in"] },
          account: { type: "string" },
          variable: { type: "boolean" },
          note: { type: "string" },
        }, ["name", "cadence"]),
      },
      { name: "list_obligations", description: "List the recorded recurring checking obligations.", input_schema: obj({}) },
      { name: "remove_obligation", description: "Remove a recurring checking obligation by its name or id.", input_schema: obj({ idOrName: { type: "string" } }, ["idOrName"]) },
      {
        name: "transfer_outlook",
        description: "Compute the once-a-month joint-checking transfer AUTOMATICALLY from the daily transaction feed: current checking balance from the balance ledger, the credit card payment estimated from this cycle's logged credit charges, and the recorded recurring bills/paycheck. Use this for 'how much should Shelli transfer' going forward; it needs no manual balance or card amount. Surfacing only.",
        input_schema: obj({ throughDate: { type: "string" } }),
      },
      {
        name: "set_checking_balance",
        description: "Set/override the known joint-checking balance (a hard anchor the balance ledger advances from as new transactions post). Use when the family tells you the balance directly. asOf defaults to now.",
        input_schema: obj({ amount: { type: "number" }, asOf: { type: "string" } }, ["amount"]),
      },
      {
        name: "set_credit_statement",
        description: "Record the current credit-card STATEMENT balance due (what gets paid on the due date). This is what the transfer outlook uses for the card payment, preferred over summing charges. Use when the family tells you the statement balance or you read it off a statement. Optional card (last 4 / name), minimumDue, dueDate (YYYY-MM-DD).",
        input_schema: obj({ statementBalance: { type: "number" }, card: { type: "string" }, minimumDue: { type: "number" }, dueDate: { type: "string" } }, ["statementBalance"]),
      },
      {
        name: "add_category_rule",
        description: "Add a transaction categorization rule, e.g. tie a payee or keyword to a category. `pattern` is matched (case-insensitive) against merchant + alert text; `category` is the bucket (e.g. 'services'); optional `note` describes it; optional `source` ('checking'/'credit') limits the rule to one side. Use for recurring payees (cleaner, sitter) so their spend rolls up.",
        input_schema: obj({ pattern: { type: "string" }, category: { type: "string" }, note: { type: "string" }, source: { type: "string", enum: ["checking", "credit"] } }, ["pattern", "category"]),
      },
      {
        name: "monthly_consumption",
        description: "Recurring monthly household consumption from the recorded obligations: each recurring flow converted to a monthly-equivalent and summed (outflow vs inflow, net). Income includes the whole household (so it frames expenses vs income), while variable items like the card payment are listed separately. Use to answer 'what do we spend/earn monthly'.",
        input_schema: obj({}),
      },
      {
        name: "recurring_withdrawals",
        description: "Recurring WITHDRAWALS detected from the checking transaction history (the recurring radar over checking outflows), each with a monthly-equivalent cost. Use to find recurring outflows not yet recorded as obligations. Needs a few cycles of logged history to detect a cadence.",
        input_schema: obj({}),
      },
      {
        name: "reconcile_returns",
        description: "Reconcile TheRealReal returns against the card. Pass `returns` as the list of returned items Shey (resale) identified from the TRR orders page (each {item?, brand?, amount?, order?}); this matches them to TRR charges/credits in the spend log and reports charges, credits already received, expected credit from the returns, and what is still outstanding. Use when figuring out how much resale spend is coming back. Surfacing only.",
        input_schema: obj({
          returns: { type: "array", items: { type: "object" } },
          sinceDays: { type: "number" },
        }),
      },
      {
        name: "running_tab",
        description: "The running tab: month-to-date totals and counts for checking and credit from the logged transactions. This is the live tally the monthly statement gets reconciled against. Optional `ym` (YYYY-MM) selects a month; defaults to the current one.",
        input_schema: obj({ ym: { type: "string" } }),
      },
      {
        name: "reconcile_statement",
        description: "Reconcile an official monthly statement against the running tab for one source. Pass `source` (checking or credit) and the statement's line items as `statement` [{date, amount, merchant}]; amounts are matched on absolute value (use the same sign convention). Reports what is on the statement but missing from the tab, what is on the tab but not the statement, and the totals/difference. Surfacing only.",
        input_schema: obj({
          source: { type: "string", enum: ["checking", "credit"] },
          statement: { type: "array", items: obj({ date: { type: "string" }, amount: { type: "number" }, merchant: { type: "string" } }, ["amount"]) },
          ym: { type: "string" },
        }, ["source", "statement"]),
      },
    ],
    handlers: {
      ...memoryHandlers("finance"),
      ...decisionHandlers("finance"),
      analyze_transactions: async ({ transactions }) =>
        JSON.stringify({ ...analyzeTransactions(transactions), recurring: detectRecurring(transactions) }),
      log_transaction: async (input) => JSON.stringify(await logTransaction(input)),
      list_transactions: async (input) => JSON.stringify(await listTransactions(input || {})),
      spending_summary: async ({ sinceDays } = {}) => {
        const summary = await summarizeSpend(sinceDays != null ? { sinceDays } : {});
        return JSON.stringify({ ...summary, text: formatSpend(summary) });
      },
      plan_checking_transfer: async (input) => JSON.stringify(await planCheckingTransfer(input || {})),
      set_obligation: async (input) => JSON.stringify(await addObligation(input)),
      list_obligations: async () => formatObligations(await listObligations()),
      remove_obligation: async ({ idOrName }) => ((await removeObligation(idOrName)) ? "removed" : "not found"),
      running_tab: async ({ ym } = {}) => {
        const tab = await runningTab(ym ? { ym } : {});
        return JSON.stringify({ ...tab, text: formatRunningTab(tab) });
      },
      reconcile_statement: async ({ source, statement, ym } = {}) => {
        const src = source === "checking" ? "checking" : "credit";
        const tab = await runningTab(ym ? { ym } : {});
        const tabForSource = tab.transactions.filter((t) => (t.source === "checking" ? "checking" : "credit") === src);
        const r = reconcile(tabForSource, statement || []);
        return JSON.stringify({ ...r, text: formatReconciliation(r, { source: src }) });
      },
      transfer_outlook: async ({ throughDate } = {}) => JSON.stringify(await transferOutlook(throughDate ? { throughDate } : {})),
      set_checking_balance: async ({ amount, asOf } = {}) => JSON.stringify(await setCheckingAnchor({ amount, asOf })),
      set_credit_statement: async (input) => JSON.stringify(await setStatement(input || {})),
      add_category_rule: async (input) => JSON.stringify(await addCategoryRule(input || {})),
      monthly_consumption: async () => { const c = await monthlyConsumption(); return JSON.stringify({ ...c, text: formatConsumption(c) }); },
      recurring_withdrawals: async () => { const r = await recurringCheckingWithdrawals(); return JSON.stringify({ ...r, text: formatRecurringWithdrawals(r) }); },
      reconcile_returns: async ({ returns, sinceDays } = {}) =>
        JSON.stringify(await reconcileTrrReturns({ returns: returns || [], sinceDays: sinceDays || 120 })),
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
      { name: "list_saved_searches", description: "List the family's active saved searches, each with its number (#). Use the number when referring to a specific hunt.", input_schema: obj({}) },
      { name: "remove_saved_search", description: "Remove a saved search by its number (e.g. 3) or its id.", input_schema: obj({ id: { type: "string" } }, ["id"]) },
      {
        name: "run_saved_searches",
        description: "Run ALL saved searches now and report only the NEW matches since last time (past hits are tracked and not repeated). Use to check for fresh finds across the hunt list.",
        input_schema: obj({}),
      },
      {
        name: "export_saved_searches",
        description: "Return the raw saved-search registry as a JSON array ({id,num,query,maxPrice,sites}). This feeds Lloyd's local-browser bridge so he can run browser-only sites (Poshmark/Depop/Grailed/TheRealReal) you cannot reach from here. When asked, reply with the JSON only, nothing else.",
        input_schema: obj({}),
      },
      {
        name: "check_returns",
        description: "Read TheRealReal's account orders page (via the family's signed-in browser) and return the visible order text + order links. Use this to see which TRR items have been assigned a RETURN or refund. Read the text yourself and list the returned items (brand, item, amount if shown). Then hand that list to Patrick (finance) so he can reconcile expected credits against the card. TRR is the only resale site whose returns matter for the budget.",
        input_schema: obj({}),
      },
    ],
    handlers: {
      ...memoryHandlers("resale"),
      ...decisionHandlers("resale"),
      ...searchHandler(),
      add_saved_search: async (input) => JSON.stringify(await addSavedSearch(input)),
      list_saved_searches: async () => formatSavedSearchList(await listSavedSearches()),
      remove_saved_search: async ({ id }) => ((await removeSavedSearch(id)) ? "removed" : "not found"),
      run_saved_searches: async () => formatSavedSearchRun(await runSavedSearches()),
      export_saved_searches: async () => JSON.stringify(await listSavedSearches()),
      check_returns: async () => {
        const r = await readTrrReturns();
        // Return the page text + order links for the specialist to interpret; cap
        // the text so the tool result stays lean.
        return JSON.stringify({
          url: r.url,
          note: r.note,
          orderLinks: (r.orders || []).map((o) => o.href || o).slice(0, 40),
          text: (r.text || "").slice(0, 6000),
        });
      },
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

// COO-tier registry factories, built from the data-driven roster (workstream S).
// A COO gets the memory/decision baseline + read-only search; a company specialist
// gets the baseline only. specialistTools() filters these against AGENT_ALLOWLIST
// above, so the two stay in lockstep. Memory/decision handlers are scoped to the
// agent's own key, so one company agent can never read another's brain or log.
for (const c of cooRoster()) {
  // ctx.requests is the per-invocation collector threaded in by runSpecialist; the
  // request-tool handlers push onto it, and runSpecialist returns it to Lloyd.
  REGISTRY[c.key] = (ctx = {}) => ({
    tools: [...memoryTools(), ...decisionTools(), searchToolDef, ...requestToolDefs()],
    handlers: {
      ...memoryHandlers(c.key),
      ...decisionHandlers(c.key),
      ...searchHandler(),
      ...requestHandlers(ctx.requests),
    },
  });
}
for (const s of companySpecialistRoster()) {
  REGISTRY[s.key] = () => ({
    tools: [...memoryTools(), ...decisionTools()],
    handlers: { ...memoryHandlers(s.key), ...decisionHandlers(s.key) },
  });
}

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

export function specialistTools(agent, ctx = {}) {
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

  const { tools, handlers } = make(ctx);
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
