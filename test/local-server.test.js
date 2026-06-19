import { test, before, after } from "node:test";
import assert from "node:assert";
import { createSpecialistServer } from "../deploy/specialists/local-server.mjs";

// Spin the harness on an ephemeral port with a stub runner (no real model call)
// and exercise it over real HTTP, mirroring how Lloyd's delegate seam reaches it.
let server, base;
const KEY = "test-key";
const calls = [];

before(async () => {
  server = createSpecialistServer({
    pinnedAgent: "dev",
    key: KEY,
    runner: async (agent, task) => {
      calls.push({ agent, task });
      return `ran ${agent}: ${task}`;
    },
    log: { error() {}, info() {} },
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/`;
});

after(() => server.close());

const post = (body, headers = { "x-functions-key": KEY }) =>
  fetch(base, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("happy path returns {text} for the pinned agent", async () => {
  const res = await post({ agent: "dev", task: "lint the repo" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "ran dev: lint the repo" });
});

test("rejects a missing/wrong function key with 401", async () => {
  const res = await post({ agent: "dev", task: "x" }, {});
  assert.equal(res.status, 401);
});

test("refuses a task for a different agent (pin) with 403", async () => {
  const res = await post({ agent: "finance", task: "x" });
  assert.equal(res.status, 403);
});

test("requires a task with 400", async () => {
  const res = await post({ agent: "dev", task: "  " });
  assert.equal(res.status, 400);
});
