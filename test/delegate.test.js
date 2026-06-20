import { test, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { chooseTransport, invokeRemoteSpecialist, delegate } from "../src/delegate.js";

// --- chooseTransport (pure routing) ----------------------------------------

test("chooseTransport: local unless remote mode AND an endpoint exists", () => {
  const endpoints = { finance: "https://fn/finance" };
  assert.equal(chooseTransport("finance", { mode: "local", endpoints }), "local", "local mode forces local");
  assert.equal(chooseTransport("finance", { mode: "remote", endpoints }), "remote", "remote + endpoint -> remote");
  assert.equal(chooseTransport("chef", { mode: "remote", endpoints }), "local", "remote but no endpoint -> local");
});

// --- remote transport against a real stub Function -------------------------

let server, base, lastRequest;

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      lastRequest = { url: req.url, key: req.headers["x-functions-key"], body: JSON.parse(body || "{}") };
      if (req.url === "/boom") {
        res.writeHead(500).end("nope");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: `handled: ${lastRequest.body.task}` }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("invokeRemoteSpecialist posts {agent,task} + key and returns text", async () => {
  const cfg = { mode: "remote", functionKey: "secret-key", timeoutMs: 5000, endpoints: { finance: `${base}/finance` } };
  const out = await invokeRemoteSpecialist("finance", "check the power bill", { cfg });
  assert.equal(out, "handled: check the power bill");
  assert.deepEqual(lastRequest.body, { agent: "finance", task: "check the power bill" });
  assert.equal(lastRequest.key, "secret-key", "function key forwarded");
});

test("invokeRemoteSpecialist prefers the per-agent key over the global fallback", async () => {
  const cfg = {
    mode: "remote", functionKey: "global-key", timeoutMs: 5000,
    keys: { finance: "finance-key" },
    endpoints: { finance: `${base}/finance` },
  };
  await invokeRemoteSpecialist("finance", "t", { cfg });
  assert.equal(lastRequest.key, "finance-key", "per-agent key wins");
});

test("delegate routes to remote and returns its text", async () => {
  const cfg = { mode: "remote", timeoutMs: 5000, endpoints: { finance: `${base}/finance` } };
  const out = await delegate({ agent: "finance", task: "summarize spend" }, { cfg, localRunner: () => "LOCAL" });
  assert.equal(out, "handled: summarize spend");
});

test("delegate uses the local runner when transport is local", async () => {
  const cfg = { mode: "local", endpoints: {} };
  const out = await delegate({ agent: "chef", task: "plan dinner" }, { cfg, localRunner: (a, t) => `local:${a}:${t}` });
  assert.equal(out, "local:chef:plan dinner");
});

test("delegate forwards images to the local runner", async () => {
  const cfg = { mode: "local", endpoints: {} };
  const images = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }];
  let got;
  await delegate({ agent: "resale", task: "catalog this", images }, { cfg, localRunner: (a, t, opts) => { got = opts; return "ok"; } });
  assert.deepEqual(got.images, images, "images passed through to the runner");
});

test("remote transport includes images in the POST body when present", async () => {
  const cfg = { mode: "remote", timeoutMs: 5000, endpoints: { resale: `${base}/finance` } };
  const images = [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "ZZ" } }];
  await invokeRemoteSpecialist("resale", "catalog", { cfg, images });
  assert.deepEqual(lastRequest.body.images, images, "image blocks sent to the Function");
  // and omitted when there are none
  await invokeRemoteSpecialist("resale", "no pics", { cfg });
  assert.equal(lastRequest.body.images, undefined, "no images key when none");
});

test("delegate surfaces a graceful message on remote failure (no silent local fallback)", async () => {
  const cfg = { mode: "remote", timeoutMs: 5000, endpoints: { finance: `${base}/boom` } };
  let localCalled = false;
  const out = await delegate({ agent: "finance", task: "x" }, { cfg, localRunner: () => ((localCalled = true), "LOCAL") });
  assert.match(out, /could not reach the finance specialist/i);
  assert.equal(localCalled, false, "must NOT fall back to local (would break isolation)");
});
