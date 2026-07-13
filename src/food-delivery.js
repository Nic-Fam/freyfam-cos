// ===========================================================================
// Food-delivery ordering (DoorDash / Postmates) — workstream T.
//
// The "order me dinner" capability: reconstruct a PAST order from the family's
// delivery account and re-place it for home delivery. The natural-language asks
// Lloyd hears map to two entry points:
//   - findFoodOrders()  -> "find our last Postmates order from <restaurant>"  (READ-ONLY)
//   - resolveReorder()  -> "order what we had last time from <restaurant>"    (gated)
//
// Sibling of the Ralphs grocery order (grocery.js): same signed-in-Chrome-profile
// browser pattern on Lloyd's local Mac (residential IP, never Azure), and the same
// "reorder from history" idea (grocery-match.js). HARD CONSTRAINT: this module never
// confirms or places anything on its own authority. placeFoodOrder runs ONLY after
// the chief's confirmation gate (confirm.js) approves, exactly like placeRalphsOrder,
// and the tool that reaches it (order_food) is CHIEF_ONLY so no specialist can spend.
//
// Pure/injectable core so it's fully testable without a browser; the live
// order-history read + checkout selectors are captured in a hands-on session (see
// deploy/live-ordering-setup.md) into data/<provider>-steps.json.
// ===========================================================================
import { readFile } from "node:fs/promises";
import { runOrder, readListingFeed } from "./channels/browser.js";
import { scoreMatch } from "./grocery-match.js";

// Provider registry. Postmates is now Uber Eats' backend; "uber"/"ubereats" alias
// to it until the capture session decides postmates.com vs ubereats.com.
export const PROVIDERS = {
  doordash: {
    key: "doordash", name: "DoorDash",
    home: process.env.DOORDASH_URL || "https://www.doordash.com",
    ordersUrl: process.env.DOORDASH_ORDERS_URL || "https://www.doordash.com/orders",
    stepsPath: () => process.env.DOORDASH_STEPS_PATH || "./data/doordash-steps.json",
  },
  postmates: {
    key: "postmates", name: "Postmates",
    home: process.env.POSTMATES_URL || "https://postmates.com",
    ordersUrl: process.env.POSTMATES_ORDERS_URL || "https://postmates.com/orders",
    stepsPath: () => process.env.POSTMATES_STEPS_PATH || "./data/postmates-steps.json",
  },
};
const PROVIDER_ALIASES = { uber: "postmates", ubereats: "postmates", "uber eats": "postmates" };

/** Normalize a free-text provider name to a known key, or null if unknown. */
export function normalizeProvider(p) {
  if (!p) return null;
  const k = String(p).toLowerCase().trim();
  const key = PROVIDER_ALIASES[k] || k;
  return PROVIDERS[key] ? key : null;
}

/** Known provider keys (used to search all when the request names no provider). */
export function providerKeys() {
  return Object.keys(PROVIDERS);
}

function money(n) {
  if (n == null || n === "") return "";
  const v = Number(String(n).replace(/[^0-9.]/g, ""));
  return Number.isFinite(v) ? `$${v.toFixed(2)}` : String(n);
}
const byDateDesc = (a, b) => String(b.date || "").localeCompare(String(a.date || ""));

/**
 * READ-ONLY: read a provider's past orders via the signed-in browser. Best-effort:
 * until the live selectors are captured (capture session) this yields [] rather than
 * a fake order. Each row shape: {restaurant, items:[{name,quantity,price}], total,
 * date, orderId, url}. `read` injectable for tests.
 */
export async function readOrderHistory({ provider, read = readListingFeed } = {}) {
  const key = normalizeProvider(provider);
  const cfg = key && PROVIDERS[key];
  if (!cfg) return [];
  try {
    // The order-history grid needs provider-specific selectors from the capture
    // session to become structured rows; until then we surface nothing rather than
    // guess. (readListingFeed returns {items}; the capture session supplies fields.)
    const { items } = await read(cfg.ordersUrl, { anchorPrefix: "/orders/", fields: {} });
    return (Array.isArray(items) ? items : [])
      .filter((r) => r && r.restaurant)
      .map((r) => ({ provider: key, ...r }));
  } catch {
    return [];
  }
}

/**
 * READ-ONLY. Find past orders, optionally filtered to a restaurant (fuzzy name
 * match), newest first. `history` injectable; defaults to the live browser read of
 * the given provider (or all providers when none is named). Never places anything.
 * @returns {Promise<Array<{provider,restaurant,items,total,date,orderId,url,score?}>>}
 */
export async function findFoodOrders({ provider, restaurant, history, limit = 10 } = {}) {
  const key = normalizeProvider(provider);
  let hist = history;
  if (!hist) {
    const keys = key ? [key] : providerKeys();
    hist = [];
    for (const p of keys) hist.push(...(await readOrderHistory({ provider: p })));
  }
  let rows = (hist || []).map((o) => ({ provider: key || o.provider, ...o }));
  if (restaurant) {
    rows = rows
      .map((o) => ({ ...o, score: scoreMatch(restaurant, o.restaurant || "") }))
      .filter((o) => o.score > 0)
      .sort((a, b) => b.score - a.score || byDateDesc(a, b));
  } else {
    rows = rows.sort(byDateDesc);
  }
  return rows.slice(0, limit);
}

/**
 * Pick the order to re-place: the most recent matching the restaurant (which="last")
 * or the Nth most recent (which=N, 1-based). Returns {order, cartItems} or
 * {order:null, reason}. Does NOT place anything — the chief gates + calls placeFoodOrder.
 */
export async function resolveReorder({ provider, restaurant, which = "last", history } = {}) {
  const matches = await findFoodOrders({ provider, restaurant, history });
  if (!matches.length) {
    const where = provider ? ` on ${PROVIDERS[normalizeProvider(provider)]?.name || provider}` : "";
    return { order: null, reason: restaurant ? `No past order found from "${restaurant}"${where}.` : `No past orders found${where}.` };
  }
  let idx = 0;
  if (which !== "last") {
    const n = Number(which);
    if (Number.isFinite(n) && n >= 1) idx = Math.min(matches.length - 1, Math.floor(n) - 1);
  }
  const order = matches[idx];
  return { order, cartItems: order.items || [] };
}

/** Human list of matching past orders for the read-only lookup. Pure. No em dashes. */
export function formatFoodOrders(orders = []) {
  if (!orders.length) return "No matching past orders found.";
  return orders.map((o, i) => {
    const items = (o.items || []).map((it) => `${it.quantity ? it.quantity + "x " : ""}${it.name}`).join(", ");
    const prov = PROVIDERS[o.provider]?.name || o.provider || "";
    const meta = [prov, o.date, money(o.total)].filter(Boolean).join(", ");
    return `${i + 1}. ${o.restaurant}${meta ? ` (${meta})` : ""}${items ? `\n   ${items}` : ""}`;
  }).join("\n");
}

/** The itemized cart summary shown in the confirmation prompt. Pure. No em dashes. */
export function formatReorder(order, { address = "home" } = {}) {
  const prov = PROVIDERS[order.provider]?.name || order.provider || "delivery";
  const items = (order.items || [])
    .map((it) => `- ${it.quantity ? it.quantity + "x " : ""}${it.name}${it.price ? ` (${money(it.price)})` : ""}`)
    .join("\n");
  const last = order.date ? ` (last ordered ${order.date})` : "";
  const prev = order.total ? `Previous total ${money(order.total)}. ` : "";
  return [
    `Reorder from ${order.restaurant} via ${prov}${last}:`,
    items,
    `${prev}Plus current fees and tip, delivered to ${address}.`,
  ].filter(Boolean).join("\n");
}

/**
 * Place a reconstructed food order via the LOCAL signed-in browser (Lloyd's Mac,
 * real IP). Runs ONLY after the chief's confirmation gate approves (the "food_order"
 * kind). Until the live checkout steps are captured for the provider, it reports the
 * order is ready for manual placement rather than faking a checkout. `run` injectable.
 */
export async function placeFoodOrder(order, { run = runOrder } = {}) {
  const key = normalizeProvider(order?.provider);
  const cfg = key && PROVIDERS[key];
  if (!cfg) return `Unknown delivery provider "${order?.provider}". Nothing was ordered.`;
  const steps = await loadSteps(cfg);
  if (!steps.length) {
    return `Approved. ${cfg.name} checkout automation isn't set up yet (live capture pending), so place this order manually for now:\n${formatReorder(order)}`;
  }
  const r = await run({ url: order.url || cfg.ordersUrl, steps, pace: true });
  return `${cfg.name} order placed for ${order.restaurant}. Steps: ${r.transcript.join(", ")}`;
}

async function loadSteps(cfg) {
  try {
    const tmpl = JSON.parse(await readFile(cfg.stepsPath(), "utf8"));
    return Array.isArray(tmpl.steps) ? tmpl.steps : [];
  } catch {
    return [];
  }
}
