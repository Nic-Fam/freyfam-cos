import http from "node:http";
import { fileURLToPath } from "node:url";
import { createHash, timingSafeEqual } from "node:crypto";
import { runSpecialist } from "../../src/specialists/runner.js";
import { runSpecialistOp } from "../../src/specialists/ops.js";
import { createLogger } from "../../src/log.js";

// ===========================================================================
// LOCAL specialist harness for the Mac fleet. Frank (security) runs on a Mac
// mini and Steve (dev) on a local MacBook instead of Azure. This serves the
// SAME contract as the Azure handler (deploy/specialists/app/specialist.mjs):
//   POST {agent, task}  ->  {text}, with x-functions-key auth + an agent pin.
// So Lloyd's delegate seam reaches it over the LAN with only the endpoint URL
// changed (http://<host>:<port>/ instead of the azurewebsites.net URL).
//
// Isolation parity with Azure:
//   - auth: COS_SPECIALIST_LOCAL_KEY must match the x-functions-key header
//     (compared in constant time; the CLI refuses to start without it)
//   - bind: 127.0.0.1 by default so it is NOT exposed to the whole LAN. A real
//     Lloyd-on-another-Mac deployment sets COS_SPECIALIST_LOCAL_HOST to the
//     Tailscale/LAN interface IP deliberately (never 0.0.0.0)
//   - agent pin: COS_AGENT names the one agent this process may serve
//   - a specialist only RETURNS text: no outbound channel, no confirmation
//     power. Those stay on Lloyd, exactly as in-process and in Azure.
// ===========================================================================

// Constant-time key check. Hash both sides so the compare length is fixed (no
// timing/length leak) and a missing header can't shortcut. No key configured =>
// auth disabled (used only by tests; the CLI requires a key).
function keyMatches(provided, expected) {
  if (!expected) return true;
  const a = createHash("sha256").update(String(provided ?? "")).digest();
  const b = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(a, b);
}

export function createSpecialistServer({ pinnedAgent, key, runner = runSpecialist, opRunner = runSpecialistOp, log = createLogger("specialist") } = {}) {
  return http.createServer((req, res) => {
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method !== "POST") return json(405, { error: "POST only" });
    // Same x-functions-key contract delegate.invokeRemoteSpecialist sends, checked
    // in constant time.
    if (!keyMatches(req.headers["x-functions-key"], key)) {
      return json(401, { error: "bad or missing function key" });
    }

    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy(); // cap body
    });
    req.on("end", async () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(400, { error: "body must be JSON {agent, task}" });
      }
      const agent = body?.agent || pinnedAgent;
      const task = body?.task;
      const op = body?.op;
      const images = Array.isArray(body?.images) ? body.images : undefined;
      // The agent pin applies to BOTH shapes so a misrouted op can't cross domains.
      if (pinnedAgent && agent !== pinnedAgent) {
        return json(403, { error: `this server serves "${pinnedAgent}", not "${agent}"` });
      }
      // Zero-model op path: {agent, op, args} -> {data}. No model, no task.
      if (op) {
        try {
          const data = await opRunner(agent, op, body?.args || {});
          return json(200, { data });
        } catch (err) {
          log.error("specialist op failed", { agent, op, reason: err.message });
          return json(400, { error: `op "${op}" failed` });
        }
      }
      if (!task || !String(task).trim()) return json(400, { error: "task or op is required" });
      try {
        // Contract is {text, requests} (workstream S step 2). Tolerate a runner
        // that returns a bare string (older/injected) by defaulting requests to [].
        const result = await runner(agent, task, { images });
        const out = typeof result === "string"
          ? { text: result, requests: [] }
          : { text: result?.text ?? "", requests: Array.isArray(result?.requests) ? result.requests : [] };
        json(200, out);
      } catch (err) {
        log.error("specialist run failed", { agent, reason: err.message });
        json(500, { error: "specialist run failed" });
      }
    });
  });
}

// CLI entry: run this on the Mac that hosts a specialist.
//   COS_AGENT=security COS_SPECIALIST_LOCAL_KEY=... PORT=8787 npm run specialist
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = createLogger("specialist");
  const pinnedAgent = process.env.COS_AGENT;
  const key = process.env.COS_SPECIALIST_LOCAL_KEY;
  const port = Number(process.env.PORT || 8787);
  // Default to localhost so the harness is never silently exposed to the LAN. A
  // real cross-Mac deployment sets this to the Tailscale/LAN IP on purpose.
  const host = process.env.COS_SPECIALIST_LOCAL_HOST || "127.0.0.1";
  if (!pinnedAgent) {
    log.error("COS_AGENT is required (e.g. security or dev)");
    process.exit(1);
  }
  // Refuse to run unauthenticated: this serves a specialist over the network, so
  // an unset key would let anyone who can reach the port invoke it. (Parity with
  // voice-server.js, which also refuses to start without its token.)
  if (!key) {
    log.error("COS_SPECIALIST_LOCAL_KEY is required (refusing to serve a specialist without auth)");
    process.exit(1);
  }
  const server = createSpecialistServer({ pinnedAgent, key });
  server.listen(port, host, () => log.info("local specialist listening", { agent: pinnedAgent, host, port, authed: true }));
}
