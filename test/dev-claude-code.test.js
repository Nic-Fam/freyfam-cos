import { test } from "node:test";
import assert from "node:assert";
import {
  runDevViaClaudeCode,
  subscriptionEnv,
  parseClaudeOutput,
  DevBackendError,
} from "../src/specialists/dev-claude-code.js";

const CFG = { bin: "claude", cwd: "/tmp/dev", timeoutMs: 5000 };

// A canned runProcess so we drive the backend without the real `claude` binary.
function fakeProc(result, capture) {
  return async (opts) => {
    if (capture) Object.assign(capture, opts);
    return { code: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
}

test("subscriptionEnv scrubs BOTH API credentials (the shadowing gotcha)", () => {
  const env = subscriptionEnv({
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    ANTHROPIC_AUTH_TOKEN: "tok",
    PATH: "/usr/bin",
  });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.PATH, "/usr/bin"); // rest of the env is preserved
});

test("parseClaudeOutput extracts result from JSON output", () => {
  assert.equal(
    parseClaudeOutput(JSON.stringify({ type: "result", is_error: false, result: "done" })),
    "done"
  );
});

test("parseClaudeOutput tolerates plain text (non-JSON)", () => {
  assert.equal(parseClaudeOutput("just text\n"), "just text");
});

test("parseClaudeOutput surfaces is_error as a typed error", () => {
  assert.throws(
    () => parseClaudeOutput(JSON.stringify({ is_error: true, result: "boom" })),
    (e) => e instanceof DevBackendError && e.code === "claude_error"
  );
});

test("runDevViaClaudeCode returns the result text on success", async () => {
  const out = await runDevViaClaudeCode("fix the bug", {
    persona: "You are Steve.",
    ctx: "Now: today",
    cfg: CFG,
    runProcess: fakeProc({ stdout: JSON.stringify({ is_error: false, result: "fixed it" }) }),
  });
  assert.equal(out, "fixed it");
});

test("runDevViaClaudeCode passes persona+ctx as --append-system-prompt and scrubs the API key", async () => {
  const seen = {};
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-be-scrubbed";
  await runDevViaClaudeCode("do a thing", {
    persona: "You are Steve.",
    ctx: "Now: today",
    cfg: CFG,
    runProcess: fakeProc({ stdout: JSON.stringify({ result: "ok" }) }, seen),
  });
  delete process.env.ANTHROPIC_API_KEY;

  assert.equal(seen.bin, "claude");
  assert.equal(seen.cwd, "/tmp/dev");
  assert.deepEqual(seen.args.slice(0, 4), ["-p", "do a thing", "--output-format", "json"]);
  const sysIdx = seen.args.indexOf("--append-system-prompt");
  assert.ok(sysIdx !== -1, "system prompt flag present");
  assert.match(seen.args[sysIdx + 1], /You are Steve\./);
  assert.match(seen.args[sysIdx + 1], /Now: today/);
  // the spawned child must NOT carry the API key, or it shadows the subscription
  assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
});

test("runDevViaClaudeCode throws usage_limit on a capped subscription", async () => {
  await assert.rejects(
    runDevViaClaudeCode("x", {
      cfg: CFG,
      runProcess: fakeProc({ code: 1, stderr: "Claude usage limit reached. Try again later." }),
    }),
    (e) => e instanceof DevBackendError && e.code === "usage_limit"
  );
});

test("runDevViaClaudeCode throws timeout when the process is killed", async () => {
  await assert.rejects(
    runDevViaClaudeCode("x", {
      cfg: CFG,
      runProcess: fakeProc({ timedOut: true, code: null }),
    }),
    (e) => e instanceof DevBackendError && e.code === "timeout"
  );
});

test("runDevViaClaudeCode throws nonzero_exit on a generic failure", async () => {
  await assert.rejects(
    runDevViaClaudeCode("x", {
      cfg: CFG,
      runProcess: fakeProc({ code: 2, stderr: "something broke" }),
    }),
    (e) => e instanceof DevBackendError && e.code === "nonzero_exit"
  );
});
