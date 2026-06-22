import { spawn } from "node:child_process";

// ===========================================================================
// Workstream Q: Steve (dev) on a Claude Code SUBSCRIPTION, not the metered API.
//
// Dev work (file edits, running tests, building the household's little apps) is
// exactly Claude Code's wheelhouse, and flat-rate subscription billing takes the
// heaviest agent off per-token cost. Steve already runs locally on the old
// MacBook, where Claude Code runs.
//
// This module is Steve's alternate execution backend: instead of the in-process
// `agentLoop` -> Anthropic API path (claude.js), it shells out to headless
// `claude -p` which resolves the subscription via the OAuth profile (no API
// key). The delegate contract {agent,task} -> text is unchanged; only Steve's
// backend differs, and only when COS_DEV_BACKEND=claude-code.
//
// THE CRITICAL GOTCHA (see TRACKER workstream Q): ANTHROPIC_API_KEY shadows the
// subscription -- it wins credential precedence. The child MUST run with both
// ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN unset, or Claude Code uses the
// metered API (defeating the point) or 401s. subscriptionEnv() enforces that.
//
// HARD CONSTRAINT preserved: this still only RETURNS text to Lloyd. The richer
// tools Claude Code gives Steve (file/bash/build) act on the local dev
// workspace, never on the family's behalf -- outbound + confirmation stay on
// Lloyd exactly as before.
// ===========================================================================

/** Typed error so the runner can decide whether to spill back to the API. */
export class DevBackendError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "DevBackendError";
    this.code = code; // 'timeout' | 'usage_limit' | 'nonzero_exit' | 'claude_error'
  }
}

/**
 * Child env that resolves the subscription: inherit the parent env but DELETE
 * the API credentials. Both must be gone -- ANTHROPIC_API_KEY wins precedence,
 * and leaving the auth token alongside the OAuth profile can 401.
 */
export function subscriptionEnv(base = process.env) {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const USAGE_LIMIT_RE = /usage limit|rate limit|quota exceeded|too many requests/i;

/**
 * Pull the final text out of `claude -p --output-format json`. Tolerates a
 * plain-text body if the output format ever changes, and surfaces a reported
 * error (is_error) as a typed DevBackendError.
 */
export function parseClaudeOutput(stdout) {
  const trimmed = (stdout || "").trim();
  if (!trimmed) return "";
  try {
    const data = JSON.parse(trimmed);
    if (data && typeof data === "object") {
      if (data.is_error) {
        throw new DevBackendError(
          String(data.result || data.error || "claude reported an error"),
          "claude_error"
        );
      }
      return typeof data.result === "string" ? data.result : trimmed;
    }
  } catch (err) {
    if (err instanceof DevBackendError) throw err;
    // not JSON -> fall through and treat stdout as plain text
  }
  return trimmed;
}

/**
 * Default subprocess runner: spawn the binary, capture stdout/stderr, enforce a
 * hard timeout (a hung dev task cannot wedge the specialist). Injectable so
 * tests drive the backend without the real `claude` binary installed.
 * Resolves {code, stdout, stderr, timedOut}; rejects only on spawn failure.
 */
export function defaultRunProcess({ bin, args, cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return reject(err);
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Run one dev task through headless Claude Code on the subscription.
 *   - persona + ctx ride as --append-system-prompt so Steve is still Steve
 *     (and gets time + standing rules + recalled memory), layered on top of
 *     Claude Code's own agentic system prompt.
 *   - the task is the -p prompt.
 *   - --output-format json gives a structured result + clean error signal.
 * Throws DevBackendError on timeout, usage cap, nonzero exit, or reported error.
 */
export async function runDevViaClaudeCode(
  task,
  { persona = "", ctx = "", cfg, runProcess = defaultRunProcess } = {}
) {
  const system = [persona, ctx].filter(Boolean).join("\n\n");
  const args = ["-p", task, "--output-format", "json"];
  if (system) args.push("--append-system-prompt", system);

  const { code, stdout, stderr, timedOut } = await runProcess({
    bin: cfg.bin,
    args,
    cwd: cfg.cwd,
    timeoutMs: cfg.timeoutMs,
    env: subscriptionEnv(),
  });

  if (timedOut) {
    throw new DevBackendError(`claude code timed out after ${cfg.timeoutMs}ms`, "timeout");
  }
  // Check the cap before the exit code: a usage-limit hit is worth a distinct
  // code so the runner (and the cap watcher) can react, not a generic failure.
  if (USAGE_LIMIT_RE.test(`${stderr}\n${stdout}`)) {
    throw new DevBackendError("claude code subscription usage limit reached", "usage_limit");
  }
  if (code !== 0) {
    throw new DevBackendError(
      `claude code exited ${code}: ${(stderr || "").trim().slice(0, 200)}`,
      "nonzero_exit"
    );
  }
  return parseClaudeOutput(stdout);
}
