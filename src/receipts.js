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
const GROCERY = /(instacart|ralphs|kroger|whole ?foods|costco|trader ?joe|safeway|albertsons|sprouts|vons|gelson|amazon fresh|shipt|weee)/i;
const PREPARED = /(doordash|uber ?eats|grubhub|postmates|caviar|chipotle|panera|sweetgreen|domino|pizza|restaurant|cafe|kitchen|grill|sushi|taco|burger)/i;
const RECEIPTY = /(receipt|order confirmation|your order|thanks for (your )?order|order #|order number|order total|payment received|invoice|amount charged|subtotal)/i;
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

/** Light, deterministic parse. Vendor from subject brand-match or sender domain. */
export function parseReceipt({ from = "", subject = "", body = "" } = {}) {
  const hay = `${subject} ${from}`;
  const brand = (hay.match(GROCERY) || hay.match(PREPARED) || [])[0];
  const vendor = (brand || vendorFromAddress(from) || subject.split(/[-|:]/)[0] || "vendor").toString().trim().slice(0, 40);
  const kind = GROCERY.test(hay) ? "grocery" : PREPARED.test(hay) ? "prepared" : "other";
  return { vendor, total: parseTotal(`${subject}\n${body}`), kind };
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
