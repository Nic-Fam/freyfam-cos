import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ===========================================================================
// Family shopping list. The SAFE half of the legacy grocery feature: a shared
// list anyone (Lloyd, or Carmine from expiring/low kitchen inventory) adds to,
// the family reviews, and that can later be handed to a shopper or an order
// flow. It does NOT spend money or place orders — that stays behind place_order
// + the confirmation gate. Local JSON store (the COS pattern).
// ===========================================================================

const STORE_PATH = () => process.env.SHOPPING_PATH || "./data/shopping.json";

async function load() {
  try {
    const d = JSON.parse(await readFile(STORE_PATH(), "utf8"));
    return Array.isArray(d.items) ? d : { items: [] };
  } catch {
    return { items: [] };
  }
}
async function save(db) {
  await mkdir(dirname(STORE_PATH()), { recursive: true });
  await writeFile(STORE_PATH(), JSON.stringify(db, null, 2));
}

/**
 * Add an item. Dedupes case-insensitively on name among open items (bumps the
 * quantity/note instead of duplicating). Returns { item, merged }.
 */
export async function addShoppingItem({ item, quantity = null, note = null, addedBy = null } = {}) {
  const name = String(item || "").trim();
  if (!name) throw new Error("item is required");
  const db = await load();
  const existing = db.items.find((i) => i.status === "open" && i.item.toLowerCase() === name.toLowerCase());
  if (existing) {
    if (quantity != null) existing.quantity = quantity;
    if (note) existing.note = note;
    await save(db);
    return { item: existing, merged: true };
  }
  const entry = {
    id: randomUUID().slice(0, 8),
    item: name,
    quantity: quantity || null,
    note: note || null,
    addedBy: addedBy || null,
    status: "open",
    addedAt: new Date().toISOString(),
  };
  db.items.push(entry);
  await save(db);
  return { item: entry, merged: false };
}

function find(items, match) {
  const m = String(match || "").trim();
  return (
    items.find((i) => i.id === m) ||
    items.find((i) => i.id.startsWith(m) && m.length >= 4) ||
    items.find((i) => i.item.toLowerCase() === m.toLowerCase())
  );
}

/** Remove an item by id/prefix/name. Returns the removed item or null. */
export async function removeShoppingItem(match) {
  const db = await load();
  const it = find(db.items, match);
  if (!it) return null;
  db.items = db.items.filter((i) => i.id !== it.id);
  await save(db);
  return it;
}

/** Clear the whole list (e.g. after a shopping run). Returns count removed. */
export async function clearShopping() {
  const db = await load();
  const n = db.items.length;
  db.items = [];
  await save(db);
  return n;
}

/** Open shopping items, oldest first. */
export async function listShopping() {
  const db = await load();
  return db.items.filter((i) => i.status === "open").sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

/** Human summary. */
export function formatShopping(items) {
  if (!items || !items.length) return "The shopping list is empty.";
  return items
    .map((i) => `- ${i.item}${i.quantity ? ` (${i.quantity})` : ""}${i.note ? ` — ${i.note}` : ""}${i.addedBy ? ` [${i.addedBy}]` : ""} {${i.id}}`)
    .join("\n");
}
