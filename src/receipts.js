// Vendor/food receipts that the family auto-forwards to cos@freyfam.com. Nic asked
// that these NEVER be rejected. We recognize them by CONTENT (not sender), capture
// them silently to a local store (no reply, no agent run), and surface them in the
// digests: the vendor+total for Patrick's spend view, and grocery items for
// Carmine's pantry. Capture is storage-only, so running it before the inbound auth
// gate does NOT weaken that gate (no reply, no model, no exfil). See memory
// vendor-receipts-intake.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const STORE = () => process.env.RECEIPTS_PATH || "./data/receipts.json";

// Grocery vendors stock the pantry; prepared-food/delivery is spend only (a DoorDash
// burrito is not inventory). Used to route items to Carmine vs just Patrick.
// [matcher, canonical vendor (null = use the matched text), kind]. Scanned over the
// subject AND body, so a FORWARD whose subject lacks the brand still resolves from
// the receipt body. Order matters: specific (Amazon Fresh) before generic (Amazon).
const BRANDS = [
  // Specific STORES first, so a Costco/Ralphs order fulfilled by Instacart labels as
  // the store (how Nic thinks of it), not the delivery platform.
  [/ralphs/i, "Ralphs", "grocery"],
  [/\bkroger\b/i, "Kroger", "grocery"],
  [/whole ?foods/i, "Whole Foods", "grocery"],
  [/trader ?joe'?s?/i, "Trader Joe's", "grocery"],
  [/\b(safeway|vons|albertsons|sprouts|gelson'?s?|shipt|weee)\b/i, null, "grocery"],
  [/\bcostco\b/i, "Costco", "grocery"],
  [/amazon ?fresh/i, "Amazon Fresh", "grocery"],
  [/instacart/i, "Instacart", "grocery"], // delivery platform: after the stores it fulfills for
  [/door ?dash/i, "DoorDash", "prepared"],
  [/uber ?eats/i, "Uber Eats", "prepared"],
  [/grubhub/i, "Grubhub", "prepared"],
  [/postmates/i, "Postmates", "prepared"],
  [/caviar\b/i, "Caviar", "prepared"],
  [/\b(chipotle|panera|sweetgreen|domino'?s?|pizza|sushi|taco|ramen|thai|bistro)\b/i, null, "prepared"],
  [/amazon/i, "Amazon", "other"], // generic Amazon LAST (after Amazon Fresh)
];
const RECEIPTY = /(receipt|order confirm(ed|ation)|your order|\bordered\b|we got your order|thanks for (your )?order|order #|order number|order total|payment received|invoice|amount charged|subtotal)/i;
const MONEY = /\$\s?\d[\d,]*\.\d{2}/;

/** Conservative: a receipt-y phrase AND a currency amount. Content-only, no sender. */
export function isReceipt({ subject = "", body = "" } = {}) {
  const hay = `${subject}\n${body}`;
  return RECEIPTY.test(hay) && MONEY.test(hay);
}

const vendorFromAddress = (from) => {
  const dom = String(from || "").toLowerCase().split("@")[1] || "";
  const core = dom.replace(/^(mail|no-?reply|noreply|orders?|receipts?|info|notifications?)\./, "").split(".")[0];
  return core || "";
};

// Pick the order total: prefer an amount on a line that says "total" (not "subtotal"),
// else the largest amount seen. Pure + exported for tests.
export function parseTotal(text) {
  const s = String(text || "");
  const amt = (m) => Number(String(m).replace(/[^0-9.]/g, ""));
  const totalLine = s.split(/\n/).find((l) => /(^|[^b])total\b/i.test(l) && MONEY.test(l) && !/sub-?total/i.test(l));
  if (totalLine) { const m = totalLine.match(/\$\s?\d[\d,]*\.\d{2}/); if (m) return amt(m[0]); }
  const all = (s.match(/\$\s?\d[\d,]*\.\d{2}/g) || []).map(amt).filter((n) => Number.isFinite(n));
  return all.length ? Math.max(...all) : null;
}

/** Light, deterministic parse. Vendor from a brand match in the subject/body (so it
 *  works on forwards), else the sender domain — never a forwarding gmail/family one. */
export function parseReceipt({ from = "", subject = "", body = "" } = {}) {
  const hay = `${subject}\n${body}\n${from}`; // include From: an auto-forward's sender IS the vendor
  let vendor = null, kind = "other";
  for (const [re, name, k] of BRANDS) {
    const m = hay.match(re);
    if (m) { vendor = name || m[0]; kind = k; break; }
  }
  if (!vendor) {
    const dom = vendorFromAddress(from);
    vendor = dom && !/^(gmail|outlook|yahoo|hotmail|icloud|me|freyfam|proton)$/i.test(dom)
      ? dom
      : (subject.replace(/^\s*fwd?:\s*/i, "").split(/[-|:,]/)[0] || "vendor").trim();
  }
  return { vendor: String(vendor).trim().slice(0, 40), total: parseTotal(hay), kind };
}

const sig = (r) => `${String(r.from || "").toLowerCase()}|${String(r.subject || "").toLowerCase().trim()}|${r.date}`;

async function load() { try { return JSON.parse(await readFile(STORE(), "utf8")); } catch { return { items: [] }; } }
async function save(db) { await mkdir(dirname(STORE()), { recursive: true }); await writeFile(STORE(), JSON.stringify(db, null, 2)); }

/** Capture a receipt (idempotent by sender+subject+day). Returns the stored row or null if dup. */
export async function captureReceipt({ from = "", subject = "", body = "", at } = {}, now = Date.now()) {
  const date = new Date(at || now).toISOString().slice(0, 10);
  const parsed = parseReceipt({ from, subject, body });
  const row = { id: `${date}:${Math.random().toString(36).slice(2, 8)}`, from, subject, date, ...parsed, capturedAt: new Date(now).toISOString() };
  const db = await load();
  if (db.items.some((it) => sig(it) === sig(row))) return null; // already captured
  db.items.push(row);
  if (db.items.length > 2000) db.items = db.items.slice(-2000); // cap
  await save(db);
  return row;
}

export async function listReceipts({ sinceDays = 14, kind } = {}, now = new Date()) {
  const cutoff = new Date(now.getTime() - sinceDays * 864e5).toISOString().slice(0, 10);
  return (await load()).items
    .filter((r) => r.date >= cutoff && (!kind || r.kind === kind))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export function formatReceipts(items) {
  if (!items || !items.length) return "No recent receipts.";
  return items.map((r) => `- ${r.date} ${r.vendor}${r.total != null ? ` $${r.total.toFixed(2)}` : ""}${r.kind === "grocery" ? " (grocery)" : ""}`).join("\n");
}

// --- Finance reconciliation (double entry = the reconciliation) ---------------
// A receipt and the bank's card charge for the SAME purchase are two views of one
// transaction. Match them (fuzzy merchant, within a few days, charge >= receipt up
// to a tip) to CONFIRM + itemize; a receipt with no charge is pending; a merchant/
// date match whose amount is out of range is a MISMATCH to flag. The ledger total
// still counts the bank charge once — receipts annotate, they don't double-spend.
const round2 = (x) => Math.round(Number(x) * 100) / 100;
const canon = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function merchantMatch(vendor, merchant) {
  const v = canon(vendor), m = canon(merchant);
  const vtok = v.split(" ")[0];
  if (!vtok || vtok.length < 4 || !m) return false;
  return m.includes(vtok) || v.includes((m.split(" ")[0] || "\0"));
}

export function reconcileReceipts(receipts, transactions, { dayWindow = 3, tipMax = 0.30 } = {}) {
  const txns = (transactions || []).filter((t) => t && t.amount != null);
  const matched = [], pending = [], discrepancies = [];
  for (const r of receipts || []) {
    if (r.total == null) continue; // can't reconcile without a total
    const rd = Date.parse(r.date);
    const cands = txns.filter((t) => merchantMatch(r.vendor, t.merchant) && Math.abs((Date.parse(t.date) - rd) / 864e5) <= dayWindow);
    if (!cands.length) { pending.push(r); continue; }
    const clean = cands.find((t) => t.amount >= r.total - 0.01 && t.amount <= r.total * (1 + tipMax) + 0.01);
    if (clean) matched.push({ receipt: r, txn: clean, tip: round2(clean.amount - r.total) });
    else discrepancies.push({ receipt: r, txn: cands[0], delta: round2(cands[0].amount - r.total) });
  }
  return { matched, pending, discrepancies };
}

export function formatReconcile({ matched, pending, discrepancies } = {}) {
  matched = matched || []; pending = pending || []; discrepancies = discrepancies || [];
  if (!matched.length && !pending.length && !discrepancies.length) return null;
  const parts = [`Receipts reconciled: ${matched.length} matched to a card charge${matched.some((m) => m.tip > 0.01) ? " (some incl. tip)" : ""}.`];
  if (pending.length) parts.push(`  ${pending.length} with no matching charge yet: ${pending.map((p) => `${p.vendor} $${(p.total ?? 0).toFixed(2)}`).join("; ")}`);
  if (discrepancies.length) parts.push(`  ${discrepancies.length} to check (receipt vs charge disagree): ${discrepancies.map((d) => `${d.receipt.vendor} receipt $${(d.receipt.total ?? 0).toFixed(2)} vs charge $${(d.txn.amount ?? 0).toFixed(2)}`).join("; ")}`);
  return parts.join("\n");
}

// --- Chef: prepared-food order size -> leftovers, calendar-aware ---------------
// Servings estimated from the order total; headcount = family + any guests the
// CALENDAR shows that evening. Bigger than headcount and no guest event => leftovers
// for the next day (Carmine plans lighter). A guest event means the order is for
// them, so no leftover inference. Calendar is the source of truth for headcount.
const GUEST_RE = /\b(dinner|guests?|party|potluck|bbq|barbecue|brunch|company|visit(?:or|ing)?|hosting|host|people over|over for|birthday|celebrat)/i;

export function guestsOnDate(events, date) {
  return (events || []).some((e) => String(e.start || "").slice(0, 10) === date && GUEST_RE.test(e.subject || ""));
}
export function estimateServings(receipt, { perServing = 16 } = {}) {
  const t = Number(receipt?.total);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.max(1, Math.round(t / perServing));
}
export function leftoverEstimate({ receipt, events = [], familySize = 3, perServing = 16 } = {}) {
  if (!receipt || receipt.kind !== "prepared") return { likely: false, reason: "not a prepared-food order" };
  const servings = estimateServings(receipt, { perServing });
  if (guestsOnDate(events, receipt.date)) return { likely: false, servings, guests: true, reason: "guests on the calendar that day" };
  const leftovers = servings - familySize;
  return { likely: leftovers >= 1, servings, leftovers: Math.max(0, leftovers), guests: false };
}

/** Mark receipts as leftover-processed so the daily chef pass doesn't re-notify. */
export async function markLeftoverProcessed(ids = []) {
  if (!ids.length) return;
  const set = new Set(ids);
  const db = await load();
  for (const it of db.items) if (set.has(it.id)) it.leftoverProcessed = true;
  await save(db);
}
