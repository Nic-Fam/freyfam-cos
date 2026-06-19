// Kitchen + meal-planning data layer for the daemon.
//
// This is a faithful ESM port of the meal-planning feature already built in the
// Azure-Functions repo (src/meal-plans.js + src/meals/*). It talks to the SAME
// Azure Tables on the SAME storage account, so Carmine (the kitchen specialist)
// reads and writes the very rows that feature created — nothing is duplicated.
//
//   Table 'mealPlans'      : PartitionKey=YYYY-MM-DD, RowKey=mealType
//   Table 'inventory'      : PartitionKey='active',  RowKey=`${expires}_${ts}_${rand}`
//   Table 'inventoryEvents': PartitionKey=YYYY-MM,   RowKey=`${ISO}_${rand}` (append-only ledger)
//
// Connection comes from AZURE_STORAGE_CONNECTION_STRING (the daemon's name for the
// same value the Function App calls AzureWebJobsStorage).

import { TableClient } from "@azure/data-tables";

const CONN = () => process.env.AZURE_STORAGE_CONNECTION_STRING;
const TZ = process.env.HOUSEHOLD_TZ || "America/Los_Angeles";

function table(name) {
  return TableClient.fromConnectionString(CONN(), name);
}
async function ensure(client) {
  try { await client.createTable(); } catch (e) { if (e.statusCode !== 409) throw e; }
}

// ===========================================================================
// Meal plans (table 'mealPlans')
// ===========================================================================

export const VALID_MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"];

export function normalizeDate(date) {
  if (!date) return null;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const local = new Date(d.toLocaleString("en-US", { timeZone: TZ }));
  const pad = (n) => String(n).padStart(2, "0");
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

export function normalizeMealType(mealType) {
  const lower = (mealType || "").toLowerCase().trim();
  if (!VALID_MEAL_TYPES.includes(lower)) {
    throw new Error(`Invalid mealType "${mealType}". Must be one of: ${VALID_MEAL_TYPES.join(", ")}`);
  }
  return lower;
}

export function mealOrderIndex(mealType) {
  const idx = VALID_MEAL_TYPES.indexOf(mealType);
  return idx === -1 ? 99 : idx;
}
export function sortByMealOrder(meals) {
  return meals.sort((a, b) => mealOrderIndex(a.mealType) - mealOrderIndex(b.mealType));
}
export function todayLocal() {
  return normalizeDate(new Date());
}

function entityToMeal(e) {
  return {
    date: e.partitionKey,
    mealType: e.rowKey,
    name: e.name,
    prepMinutes: e.prepMinutes == null ? null : Number(e.prepMinutes),
    notes: e.notes || "",
    source: e.source || "manual",
    recipeUrl: e.recipeUrl || "",
    createdAt: e.createdAt || "",
  };
}

export async function saveMeal({ date, mealType, name, prepMinutes, notes, source, recipeUrl, createdBy }) {
  const partitionKey = normalizeDate(date);
  const rowKey = normalizeMealType(mealType);
  if (!partitionKey) throw new Error(`Invalid date: ${date}`);
  if (!name || !name.trim()) throw new Error("name is required");
  const client = table("mealPlans");
  await ensure(client);
  await client.upsertEntity(
    {
      partitionKey,
      rowKey,
      name: name.trim().substring(0, 200),
      prepMinutes: prepMinutes == null ? null : Math.max(0, Math.round(prepMinutes)),
      notes: (notes || "").substring(0, 500),
      source: source || "manual",
      recipeUrl: recipeUrl || "",
      createdAt: new Date().toISOString(),
      createdBy: createdBy || "",
    },
    "Replace"
  );
  return { date: partitionKey, mealType: rowKey };
}

export async function deleteMeal(date, mealType) {
  const partitionKey = normalizeDate(date);
  const rowKey = normalizeMealType(mealType);
  const client = table("mealPlans");
  try {
    await client.deleteEntity(partitionKey, rowKey);
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
}

export async function getMealsInRange(startDate, endDate) {
  const start = normalizeDate(startDate);
  const end = normalizeDate(endDate);
  if (!start || !end) return [];
  const client = table("mealPlans");
  await ensure(client);
  const out = [];
  for await (const e of client.listEntities({
    queryOptions: { filter: `PartitionKey ge '${start}' and PartitionKey le '${end}'` },
  })) {
    out.push(entityToMeal(e));
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || mealOrderIndex(a.mealType) - mealOrderIndex(b.mealType));
  return out;
}

export function formatMealLine(meal) {
  const prep = meal.prepMinutes ? ` (${meal.prepMinutes} min prep)` : "";
  const note = meal.notes ? ` - ${meal.notes}` : "";
  const url = meal.recipeUrl ? ` [${meal.recipeUrl}]` : "";
  const label = meal.mealType.charAt(0).toUpperCase() + meal.mealType.slice(1);
  return `${label}: ${meal.name}${prep}${note}${url}`;
}

export function formatMealsContext(meals, { headerLabel = "Planned meals" } = {}) {
  if (!meals || meals.length === 0) return null;
  const byDate = {};
  for (const m of meals) (byDate[m.date] ||= []).push(m);
  const today = todayLocal();
  const lines = [`--- ${headerLabel} ---`];
  for (const date of Object.keys(byDate).sort()) {
    lines.push((date === today ? `${date} (today)` : date) + ":");
    for (const m of sortByMealOrder(byDate[date])) lines.push(`  ${formatMealLine(m)}`);
  }
  return lines.join("\n");
}

// ===========================================================================
// Expiration helpers (shelf-life defaults; table 'inventory')
// ===========================================================================

export const SHELF_LIFE_DEFAULTS = {
  produce: 7, "produce:opened": 3,
  dairy: 14, "dairy:opened": 7,
  meat: 3, "meat:opened": 2,
  pantry: 365, "pantry:opened": 90,
  frozen: 180, "frozen:opened": 60,
  bakery: 5, "bakery:opened": 3,
  beverage: 90, "beverage:opened": 7,
  condiment: 365, "condiment:opened": 180,
  snack: 60, "snack:opened": 14,
  other: 30, "other:opened": 14,
};

export function estimateExpiration({ category, opened, addedAt, openedAt }) {
  const cat = category || "other";
  const key = opened ? `${cat}:opened` : cat;
  const days = SHELF_LIFE_DEFAULTS[key] ?? SHELF_LIFE_DEFAULTS.other;
  const anchor = opened && openedAt ? new Date(openedAt) : new Date(addedAt || Date.now());
  return new Date(anchor.getTime() + days * 86400000).toISOString().slice(0, 10);
}

export function daysUntil(expiresAt) {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86400000);
}

export async function getExpiringSoon(days = 4) {
  const client = table("inventory");
  const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const items = [];
  try {
    for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'active'` } })) {
      const expiresAt = e.expiresAt || "";
      if (!expiresAt || expiresAt.slice(0, 10) > cutoff) continue;
      items.push({
        id: e.rowKey, name: e.displayName || e.name, category: e.category, location: e.location,
        quantity: e.quantity, unit: e.unit, opened: !!e.opened, expiresAt, daysUntil: daysUntil(expiresAt),
      });
    }
  } catch (e) {
    if (e.statusCode === 404) return [];
    throw e;
  }
  items.sort((a, b) => (a.expiresAt || "").localeCompare(b.expiresAt || ""));
  return items;
}

// ===========================================================================
// Inventory event ledger (table 'inventoryEvents')
// ===========================================================================

async function recordEvent({ eventType, inventoryId, name, category, quantityDelta, actor, meta }) {
  const client = table("inventoryEvents");
  await ensure(client);
  const now = new Date();
  const partitionKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const rowKey = `${now.toISOString()}_${Math.random().toString(36).slice(2, 8)}`;
  await client.createEntity({
    partitionKey, rowKey,
    eventType: eventType || "edited",
    inventoryId: inventoryId || "",
    name: (name || "").toLowerCase().slice(0, 100),
    category: category || "other",
    quantityDelta: typeof quantityDelta === "number" ? quantityDelta : 0,
    actor: actor || "system",
    meta: meta ? JSON.stringify(meta).slice(0, 2000) : "",
  });
  return rowKey;
}

// ===========================================================================
// Inventory (table 'inventory')
// ===========================================================================

const VALID_CATEGORIES = new Set(["produce", "dairy", "meat", "pantry", "frozen", "bakery", "beverage", "condiment", "snack", "other"]);
const VALID_LOCATIONS = new Set(["fridge", "freezer", "pantry", "counter", "other"]);
const normName = (s) => (s || "").toString().trim().toLowerCase().slice(0, 100);
const sanitizeCategory = (c) => (VALID_CATEGORIES.has((c || "").toLowerCase().trim()) ? c.toLowerCase().trim() : "other");
const sanitizeLocation = (l) => (VALID_LOCATIONS.has((l || "").toLowerCase().trim()) ? l.toLowerCase().trim() : "pantry");

function makeRowKey(expiresAt) {
  const sortKey = (expiresAt || "9999-99-99").slice(0, 10);
  return `${sortKey}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function entityToItem(e) {
  return {
    id: e.rowKey, name: e.name, displayName: e.displayName || e.name, barcode: e.barcode || "",
    category: e.category, location: e.location,
    quantity: typeof e.quantity === "number" ? e.quantity : Number(e.quantity) || 1,
    unit: e.unit || "", opened: !!e.opened, openedAt: e.openedAt || "",
    originalExpiresAt: e.originalExpiresAt || "", expiresAt: e.expiresAt || "",
    daysUntil: e.expiresAt ? daysUntil(e.expiresAt) : null,
    addedAt: e.addedAt || "", addedBy: e.addedBy || "", source: e.source || "", notes: e.notes || "",
  };
}

export async function listActive({ location, category, expiresBefore, query } = {}) {
  const client = table("inventory");
  const items = [];
  try {
    for await (const e of client.listEntities({ queryOptions: { filter: `PartitionKey eq 'active'` } })) {
      const it = entityToItem(e);
      if (location && it.location !== location) continue;
      if (category && it.category !== category) continue;
      if (expiresBefore && it.expiresAt && it.expiresAt.slice(0, 10) > expiresBefore) continue;
      if (query) {
        const q = query.toLowerCase();
        if (!it.name.includes(q) && !it.displayName.toLowerCase().includes(q)) continue;
      }
      items.push(it);
    }
  } catch (e) {
    if (e.statusCode === 404) return [];
    throw e;
  }
  items.sort((a, b) => (a.expiresAt || "9999-99-99").localeCompare(b.expiresAt || "9999-99-99"));
  return items;
}

export async function getById(id) {
  const client = table("inventory");
  try {
    return entityToItem(await client.getEntity("active", id));
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

export async function addItem(item) {
  const client = table("inventory");
  await ensure(client);
  const name = normName(item.name);
  const category = sanitizeCategory(item.category);
  const location = sanitizeLocation(item.location);
  const opened = !!item.opened;
  const addedAt = new Date().toISOString();
  const openedAt = opened ? item.openedAt || addedAt : "";
  const originalExpiresAt = (item.originalExpiresAt || item.expiresAt || "").slice(0, 10);
  const expiresAt = (item.expiresAt || originalExpiresAt || estimateExpiration({ category, opened, addedAt, openedAt })).slice(0, 10);
  const rowKey = makeRowKey(expiresAt);
  const entity = {
    partitionKey: "active", rowKey, name,
    displayName: (item.displayName || item.name || "").toString().slice(0, 120),
    barcode: (item.barcode || "").toString().slice(0, 40),
    category, location, quantity: Number(item.quantity) || 1,
    unit: (item.unit || "").toString().slice(0, 30),
    opened, openedAt, originalExpiresAt: originalExpiresAt || expiresAt, expiresAt, addedAt,
    addedBy: (item.addedBy || "").toString().slice(0, 40),
    source: (item.source || "manual").toString().slice(0, 20),
    notes: (item.notes || "").toString().slice(0, 500),
  };
  await client.createEntity(entity);
  await recordEvent({
    eventType: "added", inventoryId: rowKey, name, category,
    quantityDelta: entity.quantity, actor: entity.addedBy || entity.source,
    meta: { source: entity.source, location, expiresAt },
  });
  return entityToItem(entity);
}

export async function consume(id, { quantity, actor } = {}) {
  const client = table("inventory");
  const existing = await getById(id);
  if (!existing) return null;
  const requested = typeof quantity === "number" ? quantity : existing.quantity;
  const remaining = existing.quantity - requested;
  if (remaining <= 0) {
    await client.deleteEntity("active", existing.id);
    await recordEvent({
      eventType: "consumed", inventoryId: existing.id, name: existing.name, category: existing.category,
      quantityDelta: -existing.quantity, actor: actor || "ui", meta: { fullyConsumed: true },
    });
    return null;
  }
  const entity = { partitionKey: "active", rowKey: existing.id, ...toEntityFields(existing), quantity: remaining };
  await client.updateEntity(entity, "Replace");
  await recordEvent({
    eventType: "partial_consumed", inventoryId: existing.id, name: existing.name, category: existing.category,
    quantityDelta: -requested, actor: actor || "ui", meta: { remaining },
  });
  return entityToItem(entity);
}

function toEntityFields(it) {
  return {
    name: it.name, displayName: it.displayName, barcode: it.barcode, category: it.category,
    location: it.location, quantity: it.quantity, unit: it.unit, opened: it.opened, openedAt: it.openedAt,
    originalExpiresAt: it.originalExpiresAt, expiresAt: it.expiresAt, addedAt: it.addedAt,
    addedBy: it.addedBy, source: it.source, notes: it.notes,
  };
}

export async function summary({ expiringDays = 4, recentDays = 3 } = {}) {
  const all = await listActive();
  const now = Date.now();
  const recentCutoff = new Date(now - recentDays * 86400000).toISOString();
  const expiringCutoff = new Date(now + expiringDays * 86400000).toISOString().slice(0, 10);
  const counts = {};
  const expiringSoon = [];
  const recentlyAdded = [];
  for (const it of all) {
    counts[it.category] = (counts[it.category] || 0) + 1;
    if (it.expiresAt && it.expiresAt.slice(0, 10) <= expiringCutoff) expiringSoon.push(it);
    if (it.addedAt && it.addedAt >= recentCutoff) recentlyAdded.push(it);
  }
  expiringSoon.sort((a, b) => (a.expiresAt || "").localeCompare(b.expiresAt || ""));
  recentlyAdded.sort((a, b) => (b.addedAt || "").localeCompare(a.addedAt || ""));
  return { total: all.length, counts, expiringSoon: expiringSoon.slice(0, 10), recentlyAdded: recentlyAdded.slice(0, 8) };
}
