import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-saved-searches-test.json");
const HITS = join(os.tmpdir(), "cos-saved-hits-test.json");
const BRAIN = join(os.tmpdir(), "cos-saved-brain-test.json");
process.env.SAVED_SEARCHES_PATH = TMP;
process.env.SAVED_SEARCH_HITS_PATH = HITS; // isolate the removal cascade from real data
process.env.BRAIN_PATH = BRAIN;
const { addSavedSearch, listSavedSearches, removeSavedSearch, removeHunt, formatSavedSearchList, huntTokens, textMatchesHunt, matchesAnyHunt } = await import("../src/saved-searches.js");

const clean = () => Promise.all([rm(TMP, { force: true }), rm(HITS, { force: true }), rm(BRAIN, { force: true })]);
beforeEach(clean);
after(clean);

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

test("removing a search cascades: its past hits are cleared too (no resurface)", async () => {
  const a = await addSavedSearch({ query: "Alaia heel 38" });
  // seed accumulated hits for this search + one for a different search
  await writeFile(HITS, JSON.stringify({ items: [
    { id: "h1", searchId: a.id, url: "u1" },
    { id: "h2", searchId: a.id, url: "u2" },
    { id: "h3", searchId: "other", url: "u3" },
  ] }));
  assert.equal(await removeSavedSearch(a.id), true);
  const hitsLeft = JSON.parse(await readFile(HITS, "utf8")).items;
  assert.deepEqual(hitsLeft.map((h) => h.id), ["h3"], "only the removed search's hits are cleared");
});

test("removeHunt clears ALL per-site searches for a piece at once", async () => {
  await addSavedSearch({ label: "MSGM Fringe Dress - eBay", query: "MSGM fringe dress" });
  await addSavedSearch({ label: "MSGM Fringe Dress - Poshmark", query: "MSGM fringe dress" });
  await addSavedSearch({ label: "Gucci loafers - eBay", query: "Gucci loafers" });
  const res = await removeHunt("msgm fringe");
  assert.equal(res.count, 2);
  const left = await listSavedSearches();
  assert.deepEqual(left.map((s) => s.label), ["Gucci loafers - eBay"], "the unrelated hunt is untouched");
});

test("huntTokens pulls significant terms (>=3 chars) from query + label, deduped", () => {
  assert.deepEqual(huntTokens({ query: "Dsquared2 FW2014 feather top", label: "Feather Top" }),
    ["dsquared2", "fw2014", "feather", "top"]);
  // short tokens like a size "39" are dropped as too noisy to hone on
  assert.deepEqual(huntTokens({ query: "Margiela Tabi 39" }), ["margiela", "tabi"]);
});

test("textMatchesHunt hones: needs >=2 hunt tokens (or the sole token)", () => {
  const hunt = { query: "Dsquared2 FW2014 feather top" };
  // grid title carries brand + descriptors but not the season code -> still matches
  assert.equal(textMatchesHunt("Dsquared2 Feather Top", hunt), true);
  // brand alone is not enough to count as the specific piece
  assert.equal(textMatchesHunt("Dsquared2 denim jacket", hunt), false);
  // a one-word hunt matches on that single token
  assert.equal(textMatchesHunt("Chanel classic flap", { query: "Chanel" }), true);
  assert.equal(textMatchesHunt("Gucci loafers", { query: "Chanel" }), false);
});

test("matchesAnyHunt matches across hunts; no hunts -> unfiltered (matches all)", () => {
  const hunts = [{ query: "Margiela Tabi" }, { query: "Chanel flap" }];
  assert.equal(matchesAnyHunt("Maison Margiela Tabi boots", hunts), true);
  assert.equal(matchesAnyHunt("Chanel Classic Flap bag", hunts), true);
  assert.equal(matchesAnyHunt("Bottega Veneta Cabat", hunts), false);
  assert.equal(matchesAnyHunt("anything at all", []), true, "no hunts -> nothing to hone to");
});

test("formatSavedSearchList shows the number, price cap, and sites", async () => {
  await addSavedSearch({ query: "Chanel flap", maxPrice: 3000, sites: ["poshmark", "vestiaire"] });
  const out = formatSavedSearchList(await listSavedSearches());
  assert.match(out, /#1 Chanel flap \(under \$3000\) \[poshmark, vestiaire\]/);
  assert.equal(formatSavedSearchList([]), "No saved searches yet.");
});
