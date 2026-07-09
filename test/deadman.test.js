import { test } from "node:test";
import assert from "node:assert";
import { pingOnce, startDeadManBeacon } from "../src/deadman.js";

test("pingOnce is a no-op with no URL (never calls fetch)", async () => {
  let called = false;
  const ok = await pingOnce({ url: "", fetchImpl: async () => { called = true; return { ok: true }; } });
  assert.equal(ok, false);
  assert.equal(called, false);
});

test("pingOnce POSTs a liveness body to the ping URL", async () => {
  let seen = null;
  const ok = await pingOnce({
    url: "https://hc-ping.com/abc",
    fetchImpl: async (url, opts) => { seen = { url, ...opts }; return { ok: true }; },
  });
  assert.equal(ok, true);
  assert.equal(seen.url, "https://hc-ping.com/abc");
  assert.equal(seen.method, "POST");
  assert.equal(seen.body, "alive");
});

test("pingOnce includes statusFn output as the body", async () => {
  let body = null;
  await pingOnce({
    url: "https://hc-ping.com/abc",
    statusFn: async () => "on fiber (AS7018)",
    fetchImpl: async (_u, opts) => { body = opts.body; return { ok: true }; },
  });
  assert.equal(body, "on fiber (AS7018)");
});

test("pingOnce swallows a failed ping (link down) and returns false", async () => {
  const ok = await pingOnce({
    url: "https://hc-ping.com/abc",
    fetchImpl: async () => { throw new Error("network unreachable"); },
  });
  assert.equal(ok, false);
});

test("startDeadManBeacon is a no-op returning a stop fn when URL unset", () => {
  const stop = startDeadManBeacon({ url: "" });
  assert.equal(typeof stop, "function");
  stop();
});
