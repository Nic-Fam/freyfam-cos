import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-saved-searches-test.json");
process.env.SAVED_SEARCHES_PATH = TMP;
const { addSavedSearch, listSavedSearches, removeSavedSearch } = await import("../src/saved-searches.js");

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
