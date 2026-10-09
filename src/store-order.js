// ===========================================================================
// Store orders run by Lloyd's own browser agent (browser-agent.js). Two phases so
// spending money stays behind the family's YES (hard constraints #2/#3):
//
//   startStoreOrder  -> "fill": the agent builds the cart from the store's To Do
//                       list and STOPS at review (it physically cannot click a
//                       Place-order button: the commit guard refuses it). The real
//                       cart (items, dropped, total, window) is staged via
//                       confirm.js as a "store_order" approval.
//   placeStoreOrder  -> "submit": the "store_order" action handler, run ONLY after
//                       the YES. The agent re-checks the cart against the approved
//                       total and places it, then the ordered To Do items are
//                       marked done.
//
// Costco (Instacart) is first: no login wall and no loyalty gate in the July dry
// run. Ralphs works the same way but stays off the Friday auto-trigger until it is
// proven live. Deps are injectable so the whole flow is testable without a browser.
// ===========================================================================
import { runBrowserTask, browserAgentEnabled } from "./browser-agent.js";
import { buildGroceryPlaybook, validateGroceryResult, STORE_URLS } from "./grocery-order-playbook.js";
import { gatherGroceryItems } from "./grocery.js";
import { listTodoTasks, completeTodoTask } from "./channels/graph.js";
import { createLogger } from "./log.js";

const log = createLogger("store-order");

export const STORES = {
  costco: { name: "Costco", list: "Costco", hosts: ["instacart.com"] },
  ralphs: { name: "Ralphs", list: "Ralphs", hosts: ["ralphs.com", "kroger.com"], fuelCoupon: true },
};

const money = (n) => (Number.isFinite(Number(n)) ? `$${Number(n).toFixed(2)}` : "?");

/** Approval text for a filled cart. Pure. */
export function formatCartForApproval(store, r) {
  const s = STORES[store];
  const added = (r.added || []).map((a) => `- ${a.qty && a.qty !== 1 ? `${a.qty}x ` : ""}${a.item}`).join("\n");
  const dropped = (r.dropped || []).length ? `\nOut of stock, left off: ${r.dropped.join(", ")}` : "";
  return `${s.name} cart is ready (${(r.added || []).length} items, ${money(r.total)}, ${r.window || "next available slot"}):\n${added}${dropped}\n\nApprove and I'll place it.`;
}

/**
 * Fill phase. Builds the cart, then stages it for approval. Returns a short status
 * line for the family. Never places an order.
 */
export async function startStoreOrder(store, { deps = {} } = {}) {
  const s = STORES[store];
  if (!s) return `I can only order from ${Object.keys(STORES).join(" or ")} right now.`;
  if (!browserAgentEnabled()) return "My browser agent isn't switched on yet (COS_BROWSER_AGENT), so I can't build the cart myself.";
  const { gather = gatherGroceryItems, run = runBrowserTask, stage, notify = async () => {} } = deps;
  if (!stage) throw new Error("startStoreOrder needs deps.stage (confirm.js requestConfirmation)");

  const items = await gather({ store: s.list });
  if (!items.length) return `The ${s.name} list is empty, so there's nothing to order.`;

  const task = buildGroceryPlaybook({ store, phase: "fill", items, operator: "agent", applyFuelCoupon: Boolean(s.fuelCoupon) });
  const out = await run({ task, startUrl: STORE_URLS[store], allowedHosts: s.hosts, allowCommit: false, label: `${store} fill` });
  const v = validateGroceryResult(out.result);
  if (!v.ok) {
    const why = { not_signed_in: `the ${s.name} site wants a fresh sign-in on my Chrome profile`, wrong_account_or_address: "the account or delivery address didn't match ours", over_cap: `the cart came to ${money(v.total)}, over the ${money(v.cap)} cap`, max_turns: "the site took too many steps" }[v.reason] || `it stopped (${v.reason}${out.result?.notes ? `: ${out.result.notes}` : ""})`;
    log.warn("store order fill failed", { store, reason: v.reason, notes: out.result?.notes });
    const msg = `I couldn't build the ${s.name} cart: ${why}. Nothing was ordered.`;
    await notify(msg);
    return msg;
  }
  const r = out.result;
  await stage(formatCartForApproval(store, r), "store_order", {
    store,
    items: items.map((i) => i.item),
    added: r.added || [],
    dropped: r.dropped || [],
    total: r.total ?? null,
    window: r.window || null,
  });
  log.info("store order staged", { store, added: (r.added || []).length, total: r.total, turns: out.turns });
  return `${s.name} cart built (${(r.added || []).length} items, ${money(r.total)}). Sent for approval.`;
}

/** Submit phase: the "store_order" action handler. Runs only after the family's YES. */
export async function placeStoreOrder(params, { deps = {} } = {}) {
  const { store, added = [], total } = params || {};
  const s = STORES[store];
  if (!s) return `Unknown store "${store}"; nothing placed.`;
  if (!browserAgentEnabled()) return `Approved, but my browser agent is off, so place the ${s.name} order by hand.`;
  const { run = runBrowserTask, markDone = markListItemsDone } = deps;

  const task = buildGroceryPlaybook({
    store, phase: "submit", operator: "agent",
    items: added.map((a) => ({ item: a.item, quantity: a.qty })),
    approvedTotal: total,
  });
  const out = await run({ task, startUrl: STORE_URLS[store], allowedHosts: s.hosts, allowCommit: true, label: `${store} submit` });
  const v = validateGroceryResult(out.result);
  if (!v.ok) {
    log.warn("store order submit failed", { store, reason: v.reason, notes: out.result?.notes });
    return `I did NOT place the ${s.name} order: ${v.reason}${out.result?.notes ? ` (${out.result.notes})` : ""}. The cart is still there to check.`;
  }
  // Clear the To Do items that went in; anything dropped as out of stock stays on
  // the list for next time.
  const dropped = (params.dropped || []).map((d) => String(d).toLowerCase());
  const ordered = (params.items || []).filter((t) => {
    const k = String(t).toLowerCase();
    return !dropped.some((d) => d.includes(k) || k.includes(d));
  });
  await markDone(s.list, ordered).catch((e) => log.warn("could not clear To Do items", { reason: e.message }));
  return `${s.name} order placed${v.orderNumber ? ` (#${v.orderNumber})` : ""}: ${money(v.total)}${out.result.window ? `, ${out.result.window}` : ""}.`;
}

/** Mark the To Do items that went into the order as completed. */
export async function markListItemsDone(listName, titles, { list = listTodoTasks, complete = completeTodoTask } = {}) {
  const want = new Set(titles.map((t) => String(t).toLowerCase().trim()));
  const open = await list(listName);
  const hits = open.filter((t) => want.has(String(t.title).toLowerCase().trim()));
  for (const t of hits) await complete(t.listId, t.id);
  return hits.length;
}
