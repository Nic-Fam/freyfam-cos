import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-saved-searches-test.json");
process.env.SAVED_SEARCHES_PATH = TMP;
const { addSavedSearch, listSavedSearches, removeSavedSearch, formatSavedSearchList } = await import("../src/saved-searches.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("add -> list -> remove round-trips", async () => {
  const a = await addSavedSearch({ query: "Margiela Tabi 39", maxPrice: 400, sites: ["vestiaire"] });
  assert.ok(a.id);
  assert.equal(a.label, "Margiela Tabi 39"); // defaults to query
  assert.equal(a.maxPrice, 400);

  let all = await listSavedSearches();
  assert.equal(all.length, 1);

  assert.equal(await removeSavedSearch(a.id), true);
  assert.equal((await listSavedSearches()).length, 0);
  assert.equal(await removeSavedSearch("missing"), false);
});

test("query is required", async () => {
  await assert.rejects(() => addSavedSearch({ label: "no query" }));
});

test("assigns a stable, monotonic number to each item", async () => {
  const a = await addSavedSearch({ query: "Chanel flap" });
  const b = await addSavedSearch({ query: "Margiela Tabi" });
  const c = await addSavedSearch({ query: "Alaia heel" });
  assert.equal(a.num, 1);
  assert.equal(b.num, 2);
  assert.equal(c.num, 3);

  // removing #2 must NOT renumber the others, and the next add keeps climbing
  assert.equal(await removeSavedSearch(2), true); // remove by number
  const list = await listSavedSearches();
  assert.deepEqual(list.map((s) => s.num), [1, 3]);
  const d = await addSavedSearch({ query: "Margiela Tabi 39" });
  assert.equal(d.num, 4, "numbers are never reused");
});

test("remove accepts number, #number, or id", async () => {
  const a = await addSavedSearch({ query: "one" });
  await addSavedSearch({ query: "two" });
  assert.equal(await removeSavedSearch("#1"), true); // hash-prefixed number
  assert.equal(await removeSavedSearch(a.id), false, "already gone by id");
  const left = await listSavedSearches();
  assert.equal(left.length, 1);
  assert.equal(await removeSavedSearch(left[0].id), true); // by id still works
});

test("removes by an all-digit id without mistaking it for a search number", async () => {
  // an 8-char hex id is all-digits ~2.3% of the time; it must still resolve as an id
  const { createCollection } = await import("../src/stores/collection.js");
  const col = createCollection({ file: TMP, partition: "savedsearch" });
  await col.add({ id: "12345678", num: 1, label: "numeric id", query: "x", createdAt: "2026-01-01T00:00:00Z" });
  assert.equal(await removeSavedSearch("12345678"), true);
  assert.equal((await listSavedSearches()).length, 0);
});

test("backfills numbers for legacy items lacking one (by creation order)", async () => {
  // simulate pre-`num` rows written straight to the store, oldest first
  const { createCollection } = await import("../src/stores/collection.js");
  const col = createCollection({ file: TMP, partition: "savedsearch" });
  await col.add({ id: "old1", label: "older", query: "a", createdAt: "2026-01-01T00:00:00Z" });
  await col.add({ id: "old2", label: "newer", query: "b", createdAt: "2026-02-01T00:00:00Z" });
  const list = await listSavedSearches();
  assert.deepEqual(list.map((s) => [s.id, s.num]), [["old1", 1], ["old2", 2]]);
  // a fresh add continues from the backfilled max
  const fresh = await addSavedSearch({ query: "c" });
  assert.equal(fresh.num, 3);
});

test("formatSavedSearchList shows the number, price cap, and sites", async () => {
  await addSavedSearch({ query: "Chanel flap", maxPrice: 3000, sites: ["poshmark", "vestiaire"] });
  const out = formatSavedSearchList(await listSavedSearches());
  assert.match(out, /#1 Chanel flap \(under \$3000\) \[poshmark, vestiaire\]/);
  assert.equal(formatSavedSearchList([]), "No saved searches yet.");
});
