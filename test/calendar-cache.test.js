import { test } from "node:test";
import assert from "node:assert";
import { makeTtlCache } from "../src/channels/graph.js";

test("makeTtlCache serves a cached value within the TTL (produce runs once)", async () => {
  let now = 1000;
  let calls = 0;
  const cache = makeTtlCache(60000, () => now);
  const produce = async () => (++calls, "events");

  assert.equal(await cache.get("k", produce), "events");
  now = 1000 + 59999; // still inside the 60s window
  assert.equal(await cache.get("k", produce), "events");
  assert.equal(calls, 1, "second read inside TTL should not re-fetch");
});

test("makeTtlCache re-fetches once the TTL has elapsed", async () => {
  let now = 0;
  let calls = 0;
  const cache = makeTtlCache(60000, () => now);
  const produce = async () => (++calls, `v${calls}`);

  assert.equal(await cache.get("k", produce), "v1");
  now = 60000; // exactly at the boundary -> expired (strict <)
  assert.equal(await cache.get("k", produce), "v2");
  assert.equal(calls, 2);
});

test("makeTtlCache keys are independent", async () => {
  let calls = 0;
  const cache = makeTtlCache(60000, () => 0);
  const produce = (tag) => async () => (++calls, tag);

  assert.equal(await cache.get("a", produce("A")), "A");
  assert.equal(await cache.get("b", produce("B")), "B");
  assert.equal(await cache.get("a", produce("A")), "A"); // cached
  assert.equal(calls, 2, "distinct keys fetch independently; repeat key is cached");
});

test("clear() forces the next read to re-fetch (calendar mutation invalidation)", async () => {
  let calls = 0;
  const cache = makeTtlCache(60000, () => 0);
  const produce = async () => (++calls, "x");

  await cache.get("k", produce);
  assert.equal(cache.size(), 1);
  cache.clear();
  assert.equal(cache.size(), 0);
  await cache.get("k", produce);
  assert.equal(calls, 2, "after clear the value is re-fetched");
});

test("ttlMs <= 0 disables caching entirely", async () => {
  let calls = 0;
  const cache = makeTtlCache(0, () => 0);
  const produce = async () => (++calls, "x");

  await cache.get("k", produce);
  await cache.get("k", produce);
  assert.equal(calls, 2, "with caching disabled every get runs produce");
  assert.equal(cache.size(), 0, "nothing is stored when disabled");
});
