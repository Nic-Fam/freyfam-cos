import http from "node:http";
import { fileURLToPath } from "node:url";
import { runSpecialist } from "../../src/specialists/runner.js";
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
//   - agent pin: COS_AGENT names the one agent this process may serve
//   - a specialist only RETURNS text: no outbound channel, no confirmation
//     power. Those stay on Lloyd, exactly as in-process and in Azure.
// ===========================================================================

export function createSpecialistServer({ pinnedAgent, key, runner = runSpecialist, log = createLogger("specialist") } = {}) {
  return http.createServer((req, res) => {
    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.method !== "POST") return json(405, { error: "POST only" });
    // Same x-functions-key contract delegate.invokeRemoteSpecialist sends.
    if (key && req.headers["x-functions-key"] !== key) {
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
      const images = Array.isArray(body?.images) ? body.images : undefined;
      if (!task || !String(task).trim()) return json(400, { error: "task is required" });
      if (pinnedAgent && agent !== pinnedAgent) {
        return json(403, { error: `this server serves "${pinnedAgent}", not "${agent}"` });
      }
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
  if (!pinnedAgent) {
    log.error("COS_AGENT is required (e.g. security or dev)");
    process.exit(1);
  }
  const server = createSpecialistServer({ pinnedAgent, key });
  server.listen(port, () => log.info("local specialist listening", { agent: pinnedAgent, port, authed: Boolean(key) }));
}
