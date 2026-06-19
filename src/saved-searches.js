// Saved-search registry for the resale specialist. This is the LOCAL data half of
// the resale capability: the agent can record, list, and remove the designer
// pieces the family is hunting. The heartbeat's "resale saved-search hits" TODO
// will later poll these against Poshmark/eBay/Vestiaire/RealReal/1stDibs; that
// fetch step needs live network access and is deliberately not done here.
//
// Stored as a small JSON file so it survives restarts with zero extra services.

import { randomUUID } from "node:crypto";
import { createCollection } from "./stores/collection.js";

// Storage is pluggable (src/stores/collection.js): local JSON by default, or the
// resale specialist's own managed-identity Azure Table when COS_TABLE_* is set
// (remote on a Flex Function). Same add/list/remove API either way, so callers
// and the resale tools are unchanged.
const col = () =>
  createCollection({
    file: process.env.SAVED_SEARCHES_PATH || "./data/saved-searches.json",
    partition: "savedsearch",
  });

/** @param {{label?:string, query:string, maxPrice?:number|null, sites?:string[]}} input */
export async function addSavedSearch({ label, query, maxPrice = null, sites = [] } = {}) {
  if (!query || !String(query).trim()) throw new Error("query is required");
  const item = {
    id: randomUUID().slice(0, 8),
    label: label || query,
    query: String(query).trim(),
    maxPrice: maxPrice == null ? null : Number(maxPrice),
    sites: Array.isArray(sites) ? sites : [],
    createdAt: new Date().toISOString(),
  };
  await col().add(item);
  return item;
}

export async function listSavedSearches() {
  return col().list();
}

/** @returns {boolean} whether an item was actually removed */
export async function removeSavedSearch(id) {
  return col().remove(id);
}
