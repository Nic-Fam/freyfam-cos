// Recurring CHECKING-account obligations + a cash-flow "top-up" planner for the
// finance specialist (Patrick). Answers: "how much does Shelli need to move into
// joint checking to keep at least $X in it through the upcoming bills?"
//
// Two pure pieces + a small store:
//   - the store: the standing bills that come out of joint checking (rent, car
//     payment, weekly BrightHorizons, etc.), each with a cadence + due rule.
//   - projectOutflows(): expand those bills into dated outflows over a horizon.
//   - planTransfer(): walk the balance day by day and find the transfer that keeps
//     the LOWEST projected point at or above the buffer (not just the ending
//     balance - a mid-month dip below the buffer is what we are protecting against).
//
// HARD CONSTRAINT #3 preserved: this only computes and surfaces a number. It never
// moves money. A human (Shelli) makes the transfer. Storage is pluggable like the
// rest (local JSON, or the finance specialist's own Azure Table when COS_TABLE_*).

import { randomUUID } from "node:crypto";
import { createCollection } from "./stores/collection.js";

const col = () =>
  createCollection({
    file: process.env.OBLIGATIONS_PATH || "./data/obligations.json",
    partition: "obligation",
  });

const FAMILY_TZ = process.env.FAMILY_TZ || "America/Los_Angeles";
const round2 = (x) => Math.round(Number(x) * 100) / 100;

// --- small date helpers (date-only, no tz drift) ---------------------------
/** Today as YYYY-MM-DD in the family's timezone. */
export function todayYmd(now = new Date(), tz = FAMILY_TZ) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
const daysInMonth = (y, m /*1-12*/) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun
// Whole days from ymdB to ymdA (positive when A is after B). For biweekly cadence.
function diffDays(ymdA, ymdB) {
  const [ya, ma, da] = String(ymdA).split("-").map(Number);
  const [yb, mb, db] = String(ymdB).split("-").map(Number);
  return Math.round((Date.UTC(ya, ma - 1, da) - Date.UTC(yb, mb - 1, db)) / 86400000);
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
function niceDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ""))) return String(ymd ?? "");
  const [y, m, d] = String(ymd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(dt);
}
const money = (n) => "$" + Math.abs(round2(n)).toLocaleString("en-US", { maximumFractionDigits: 2 });
const signed = (n) => (round2(n) < 0 ? "-" : "") + money(n);
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// --- store (CRUD) ----------------------------------------------------------
/**
 * Record or UPDATE a recurring checking flow (upsert by name). Cadence:
 *   monthly  -> dueDay 1-31 (use 31 for "end of month"; clamped to month length)
 *   weekly   -> dueWeekday 0-6 (0=Sun)
 *   biweekly -> anchorDate YYYY-MM-DD (a known occurrence; repeats every 14 days)
 *   once     -> date YYYY-MM-DD
 * `direction` is "out" for a bill (default) or "in" for a deposit/paycheck.
 * `account` is "joint" (default) for flows through the joint checking the transfer
 * floor protects, or another label (e.g. "shelli") for a household-level flow that
 * must NOT affect the joint floor (Shelli's own income funds her transfer, it does
 * not land in joint) but should still count in the household consumption picture.
 * variable:true marks a flow whose amount changes each cycle (e.g. the credit
 * card payment); its amount is supplied at planning time, never guessed.
 */
export async function addObligation({ name, amount = null, cadence, dueDay, dueWeekday, anchorDate, intervalDays, date, direction = "out", account = "joint", variable = false, note = null } = {}) {
  if (!name || !String(name).trim()) throw new Error("name is required");
  cadence = String(cadence || "").toLowerCase();
  direction = String(direction).toLowerCase() === "in" ? "in" : "out";
  if (!["monthly", "weekly", "biweekly", "interval", "once"].includes(cadence)) throw new Error("cadence must be monthly, weekly, biweekly, interval, or once");
  if (cadence === "monthly" && !(dueDay >= 1 && dueDay <= 31)) throw new Error("monthly obligations need dueDay 1-31");
  if (cadence === "weekly" && !(dueWeekday >= 0 && dueWeekday <= 6)) throw new Error("weekly obligations need dueWeekday 0-6 (0=Sun)");
  if (cadence === "biweekly" && !/^\d{4}-\d{2}-\d{2}$/.test(String(anchorDate || ""))) throw new Error("biweekly obligations need anchorDate YYYY-MM-DD (a known pay date)");
  if (cadence === "interval" && (!(intervalDays >= 1) || !/^\d{4}-\d{2}-\d{2}$/.test(String(anchorDate || "")))) throw new Error("interval obligations need intervalDays (>=1) and anchorDate YYYY-MM-DD (e.g. every 21 days for a 3-week cycle)");
  if (cadence === "once" && !/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new Error("once obligations need date YYYY-MM-DD");
  if (!variable && (amount == null || Number.isNaN(Number(amount)))) throw new Error("amount is required unless variable:true");

  const c = col();
  const existing = (await c.list()).find((o) => o.name.toLowerCase() === name.trim().toLowerCase());
  if (existing) await c.remove(existing.id).catch(() => {});
  const item = {
    id: existing?.id || randomUUID().slice(0, 8),
    name: String(name).trim(),
    amount: variable ? null : round2(amount),
    cadence,
    dueDay: cadence === "monthly" ? Number(dueDay) : null,
    dueWeekday: cadence === "weekly" ? Number(dueWeekday) : null,
    anchorDate: cadence === "biweekly" || cadence === "interval" ? anchorDate : null,
    intervalDays: cadence === "interval" ? Number(intervalDays) : null,
    date: cadence === "once" ? date : null,
    direction,
    account: String(account || "joint").toLowerCase().trim() || "joint",
    variable: !!variable,
    source: "checking",
    note: note ? String(note).trim() : null,
    at: new Date().toISOString(),
  };
  await c.add(item);
  return item;
}

export async function listObligations() {
  return col().list();
}

// Monthly-equivalent multiplier for an obligation's cadence (52 weeks / 26 biweekly
// periods / 365 days a year). `interval` scales by its day count (e.g. every 21 days).
function monthlyFactor(o) {
  switch (o.cadence) {
    case "monthly": return 1;
    case "weekly": return 52 / 12;
    case "biweekly": return 26 / 12;
    case "interval": return o.intervalDays >= 1 ? (365 / o.intervalDays) / 12 : 0;
    default: return 0; // once
  }
}

/**
 * Monthly consumption from the recorded recurring flows: each obligation's amount
 * converted to a monthly-equivalent and summed (outflow vs inflow). Variable-amount
 * obligations (e.g. the credit card payment) have no fixed monthly figure, so they
 * are listed separately rather than guessed. This is the "what do we spend monthly"
 * view; the transfer floor is the dated projection. Surfacing only.
 */
export async function monthlyConsumption() {
  const items = (await listObligations()).map((o) => {
    const monthly = o.variable || o.amount == null ? null : round2(o.amount * monthlyFactor(o));
    return { name: o.name, cadence: o.cadence, amount: o.amount, monthly, direction: o.direction || "out", variable: !!o.variable };
  });
  const sum = (pred) => round2(items.filter((i) => pred(i) && i.monthly != null).reduce((a, i) => a + i.monthly, 0));
  const monthlyOutflow = sum((i) => i.direction !== "in");
  const monthlyInflow = sum((i) => i.direction === "in");
  return {
    monthlyOutflow, monthlyInflow, net: round2(monthlyInflow - monthlyOutflow),
    variableExcluded: items.filter((i) => i.variable).map((i) => i.name),
    items,
  };
}

export function formatConsumption(c) {
  if (!c || !c.items.length) return "No recurring flows recorded yet.";
  const lines = [`Recurring monthly consumption: outflow ${money(c.monthlyOutflow)}, inflow ${money(c.monthlyInflow)}, net ${signed(c.net)}.`];
  for (const i of c.items.filter((x) => x.direction !== "in").sort((a, b) => (b.monthly || 0) - (a.monthly || 0))) {
    lines.push(`  - ${i.name}: ${i.variable ? "(varies)" : money(i.monthly) + "/mo"} (${i.cadence})`);
  }
  if (c.variableExcluded.length) lines.push(`(variable, not in the total: ${c.variableExcluded.join(", ")})`);
  return lines.join("\n");
}

/** Remove by id OR by (case-insensitive) name. */
export async function removeObligation(idOrName) {
  const items = await col().list();
  const byName = items.find((o) => o.name.toLowerCase() === String(idOrName).trim().toLowerCase());
  return col().remove(byName ? byName.id : idOrName);
}

// --- projection + planning (pure) ------------------------------------------
/**
 * Expand obligations into dated outflows over [today, through]. `amounts` supplies
 * the figure for any `variable` obligation, keyed by its id OR lowercased name; a
 * variable obligation with no supplied amount is returned in `missing` (and left
 * out of the math) rather than guessed.
 * @returns {{outflows:Array<{name,amount,date,id}>, missing:Array<{name,id,date}>, start, through}}
 */
export function projectOutflows(obligations = [], { now = new Date(), throughDate, horizonDays = 45, amounts = {} } = {}) {
  const start = todayYmd(now);
  const through = throughDate || addDays(start, horizonDays);
  const outflows = [];
  const inflows = [];
  const missing = [];
  let cur = start;
  let guard = 0;
  while (cur <= through && guard++ < 800) {
    const [y, m, d] = cur.split("-").map(Number);
    for (const o of obligations) {
      // The transfer floor protects the JOINT checking only; a non-joint flow
      // (e.g. Shelli's own income) never lands here, so it must not move the floor.
      if (o.account && o.account !== "joint") continue;
      let due = false;
      if (o.cadence === "monthly") due = d === Math.min(o.dueDay, daysInMonth(y, m));
      else if (o.cadence === "weekly") due = dow(y, m, d) === o.dueWeekday;
      else if (o.cadence === "biweekly") { const gap = diffDays(cur, o.anchorDate); due = gap >= 0 && gap % 14 === 0; }
      else if (o.cadence === "interval") { const gap = diffDays(cur, o.anchorDate); due = gap >= 0 && o.intervalDays >= 1 && gap % o.intervalDays === 0; }
      else if (o.cadence === "once") due = o.date === cur;
      if (!due) continue;
      const amt = o.variable ? amounts[o.id] ?? amounts[String(o.name).toLowerCase()] : o.amount;
      if (amt == null || Number.isNaN(Number(amt))) {
        missing.push({ id: o.id, name: o.name, date: cur, direction: o.direction || "out" });
        continue;
      }
      (o.direction === "in" ? inflows : outflows).push({ name: o.name, amount: round2(amt), date: cur, id: o.id });
    }
    cur = addDays(cur, 1);
  }
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  outflows.sort(byDate);
  inflows.sort(byDate);
  return { outflows, inflows, missing, start, through };
}

/**
 * Find the transfer that keeps the projected balance at/above `buffer` at every
 * point through the horizon. Outflows are applied before inflows on the same day
 * (conservative: don't assume a deposit clears before a withdrawal). Pure.
 * @returns {{currentBalance,buffer,requiredTransfer,minBalance,minDate,minEvent,endingBalance,schedule}}
 */
export function planTransfer({ currentBalance, buffer = 1000, outflows = [], inflows = [], now = new Date() } = {}) {
  const cb = round2(currentBalance);
  const events = [
    ...outflows.map((o) => ({ date: o.date, name: o.name, delta: -Math.abs(round2(o.amount)), kind: "out" })),
    ...inflows.map((i) => ({ date: i.date, name: i.name || "deposit", delta: Math.abs(round2(i.amount)), kind: "in" })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? 0 : a.kind === "out" ? -1 : 1));

  let bal = cb;
  let minBalance = cb;
  let minDate = todayYmd(now);
  let minEvent = null;
  const schedule = [];
  for (const e of events) {
    bal = round2(bal + e.delta);
    schedule.push({ date: e.date, name: e.name, delta: e.delta, balance: bal });
    if (bal < minBalance) {
      minBalance = bal;
      minDate = e.date;
      minEvent = e.name;
    }
  }
  const shortfall = round2(buffer - minBalance);
  const requiredTransfer = shortfall > 0 ? Math.ceil(shortfall) : 0; // round UP to whole dollars: keeps balance >= buffer
  return { currentBalance: cb, buffer: round2(buffer), requiredTransfer, minBalance, minDate, minEvent, endingBalance: bal, schedule };
}

/**
 * End-to-end: load the recorded obligations, project them (+ any one-off extras),
 * and compute the required transfer. `creditCardPayment` is a convenience that
 * fills any variable obligation whose name looks like a credit card payment.
 */
export async function planCheckingTransfer({
  currentBalance, buffer, throughDate, horizonDays = 45,
  amounts = {}, creditCardPayment, extraOutflows = [], expectedInflows = [], now = new Date(),
} = {}) {
  if (currentBalance == null || Number.isNaN(Number(currentBalance))) throw new Error("currentBalance is required");
  const obligations = await listObligations();
  const amts = { ...amounts };
  if (creditCardPayment != null) {
    for (const o of obligations) if (o.variable && /credit|card/i.test(o.name)) amts[o.id] = creditCardPayment;
  }
  const { outflows, inflows: projInflows, missing, through } = projectOutflows(obligations, { now, throughDate, horizonDays, amounts: amts });
  const extras = (extraOutflows || []).filter((o) => o && o.date && o.amount != null)
    .map((o) => ({ name: o.name || "other", amount: round2(o.amount), date: o.date }));
  const allOut = [...outflows, ...extras].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Recurring inflows (paychecks) projected from the store, plus any one-off deposits.
  const extraIn = (expectedInflows || []).filter((i) => i && i.date && i.amount != null)
    .map((i) => ({ name: i.name || "deposit", amount: round2(i.amount), date: i.date }));
  const allIn = [...projInflows, ...extraIn].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const buf = buffer != null ? Number(buffer) : Number(process.env.CHECKING_BUFFER_USD ?? 1000);
  const plan = planTransfer({ currentBalance, buffer: buf, outflows: allOut, inflows: allIn, now });
  const full = { ...plan, missing, through };
  return { ...full, text: formatTransferPlan(full) };
}

// --- human formatting (family-facing: warm, brief, no em dashes) -----------
export function formatTransferPlan(plan) {
  const { currentBalance, buffer, requiredTransfer, minBalance, minDate, minEvent, endingBalance, schedule = [], missing = [], through } = plan;
  const horizon = through ? `through ${niceDate(through)}` : "through the period ahead";
  const lines = [];
  if (requiredTransfer > 0) {
    lines.push(`To keep ${money(buffer)} in joint checking ${horizon}, Shelli should transfer in about ${money(requiredTransfer)}.`);
  } else {
    lines.push(`No transfer needed to hold ${money(buffer)} ${horizon}. The lowest point stays at ${signed(minBalance)}.`);
  }
  if (schedule.length) {
    lines.push(`Lowest point: ${signed(minBalance)} on ${niceDate(minDate)}${minEvent ? ` after ${minEvent}` : ""}.`);
    lines.push("Scheduled out of checking:");
    for (const e of schedule) {
      const sign = e.delta < 0 ? "-" : "+";
      lines.push(`  - ${niceDate(e.date)}  ${e.name}  ${sign}${money(e.delta)}  -> ${signed(e.balance)}`);
    }
  }
  lines.push(`Starting balance ${signed(currentBalance)}; projected ending ${signed(endingBalance)}.`);
  if (missing.length) {
    const names = [...new Set(missing.map((m) => m.name))].join(", ");
    lines.push(`I still need an amount for: ${names}. Share it and I'll fold it into the number.`);
  }
  return lines.join("\n");
}

export function formatObligations(items) {
  if (!items || !items.length) return "No recurring checking flows recorded yet.";
  const when = (o) =>
    o.cadence === "monthly" ? `monthly on day ${o.dueDay}` :
    o.cadence === "weekly" ? `weekly on ${DOW[o.dueWeekday]}` :
    o.cadence === "biweekly" ? `every 2 weeks from ${o.anchorDate}` :
    o.cadence === "interval" ? `every ${o.intervalDays} days from ${o.anchorDate}` :
    `once on ${o.date}`;
  const amt = (o) => (o.variable ? "(amount varies)" : `${o.direction === "in" ? "+" : "-"}${money(o.amount)}`);
  return "Checking flows:\n" + items
    .map((o) => `- ${o.name}: ${amt(o)} ${when(o)}${o.direction === "in" ? " (deposit)" : ""}${o.note ? `, ${o.note}` : ""}`)
    .join("\n");
}
