// Saved-search registry for the resale specialist. This is the LOCAL data half of
// the resale capability: the agent can record, list, and remove the designer
// pieces the family is hunting. The heartbeat's "resale saved-search hits" TODO
// will later poll these against Poshmark/eBay/Vestiaire/RealReal/1stDibs; that
// fetch step needs live network access and is deliberately not done here.
//
// Stored as a small JSON file so it survives restarts with zero extra services.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const PATH = () => process.env.SAVED_SEARCHES_PATH || "./data/saved-searches.json";

async function load() {
  try {
    return JSON.parse(await readFile(PATH(), "utf8"));
  } catch {
    return { items: [] };
  }
}
async function save(db) {
  await mkdir(dirname(PATH()), { recursive: true });
  await writeFile(PATH(), JSON.stringify(db, null, 2));
}

/** @param {{label?:string, query:string, maxPrice?:number|null, sites?:string[]}} input */
export async function addSavedSearch({ label, query, maxPrice = null, sites = [] } = {}) {
  if (!query || !String(query).trim()) throw new Error("query is required");
  const db = await load();
  const item = {
    id: randomUUID().slice(0, 8),
    label: label || query,
    query: String(query).trim(),
    maxPrice: maxPrice == null ? null : Number(maxPrice),
    sites: Array.isArray(sites) ? sites : [],
    createdAt: new Date().toISOString(),
  };
  db.items.push(item);
  await save(db);
  return item;
}

export async function listSavedSearches() {
  return (await load()).items;
}

/** @returns {boolean} whether an item was actually removed */
export async function removeSavedSearch(id) {
  const db = await load();
  const before = db.items.length;
  db.items = db.items.filter((i) => i.id !== id);
  await save(db);
  return db.items.length < before;
}
