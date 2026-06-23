// ===========================================================================
// Grocery order planning (Ralphs / Kroger). The DETERMINISTIC core of the
// weekly Friday order: when to run, how to turn the shopping list into a cart,
// and the out-of-stock policy. The live checkout (login, clip the 4x fuel-points
// coupon, pick the Friday-evening slot, detect OOS, pay) is grocer-specific
// browser automation that plugs into submitGroceryOrder once live-tested; it
// spends money, so it always runs behind the confirmation gate.
//
// Goal (per Nic): order every Friday so the 4x fuel-points digital coupon
// applies to Friday purchases, delivered Friday evening. If an item is
// unavailable, DROP it so the rest of the order still completes.
// ===========================================================================

const TZ = process.env.FAMILY_TZ || "America/Los_Angeles";
const GROCERY = {
  weekday: Number(process.env.GROCERY_WEEKDAY ?? 5), // 0=Sun..6=Sat; 5 = Friday
  hour: Number(process.env.GROCERY_HOUR ?? 9), // assemble + propose in the morning so it can be approved before evening delivery
  windowHours: Number(process.env.GROCERY_WINDOW_HOURS ?? 5),
  coupons: (process.env.GROCERY_COUPONS || "4x fuel points").split(",").map((s) => s.trim()).filter(Boolean),
  deliveryWindow: process.env.GROCERY_DELIVERY_WINDOW || "Friday evening",
};

/** Local {date:YYYY-MM-DD, hour, weekday:0-6} in the family tz. weekday via noon-UTC of the local date. */
export function localDayParts(now = new Date(), tz = TZ) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(now)) % 24;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return { date, hour, weekday };
}

/**
 * Should the weekly grocery order run now? True on the configured weekday inside
 * [hour, hour+windowHours) and not already done today. Pure; returns the date so
 * the caller records it.
 */
export function shouldRunGroceryOrder(now, lastRunDate, opts = GROCERY) {
  const { weekday = 5, hour = 9, windowHours = 5, tz = TZ } = opts;
  const p = localDayParts(now, tz);
  const inWindow = p.weekday === weekday && p.hour >= hour && p.hour < hour + windowHours;
  return { run: inWindow && lastRunDate !== p.date, date: p.date };
}

/** Turn the shopping list into a Ralphs order plan. Pure. */
export function assembleOrder(shoppingItems, opts = GROCERY) {
  const items = (shoppingItems || []).map((i) => ({
    item: i.item,
    quantity: i.quantity || 1,
    note: i.note || null,
  }));
  return {
    items,
    coupons: opts.coupons,
    deliveryWindow: opts.deliveryWindow,
    count: items.length,
  };
}

/**
 * Out-of-stock policy: drop the unavailable items so the order still completes,
 * and report what was dropped (to tell the family). `unavailable` is a list of
 * item names (case-insensitive). Pure.
 */
export function applyAvailability(items, unavailable = []) {
  const out = new Set((unavailable || []).map((n) => String(n).toLowerCase().trim()));
  const kept = [];
  const dropped = [];
  for (const it of items || []) {
    if (out.has(String(it.item).toLowerCase().trim())) dropped.push(it);
    else kept.push(it);
  }
  return { kept, dropped };
}

/** Human summary of a planned order. */
export function formatOrder(order) {
  if (!order || !order.items.length) return "The shopping list is empty, so there is nothing to order.";
  const lines = order.items.map((i) => `- ${i.item}${i.quantity && i.quantity !== 1 ? ` x${i.quantity}` : ""}${i.note ? ` (${i.note})` : ""}`);
  return [
    `Ralphs delivery order (${order.count} items), ${order.deliveryWindow}, applying: ${order.coupons.join(", ")}.`,
    ...lines,
  ].join("\n");
}
