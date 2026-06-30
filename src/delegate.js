import { SPECIALISTS } from "./config.js";
import { runSpecialist } from "./specialists/runner.js";
import { createLogger } from "./log.js";

const log = createLogger("delegate");

// ===========================================================================
// THE SEAM between Lloyd and the specialists. Its contract -- {agent, task} ->
// text -- never changes; only which transport runs the work does:
//
//   local  (default): run the specialist in-process via runner.runSpecialist
//   remote          : POST to that specialist's isolated Azure Function
//
// This is the one place the Azure split touches Lloyd's code. Everything else
// (triage, the chief loop, confirmation, outbound) is identical either way.
//
// Functions take an injectable cfg + fetchImpl + localRunner so the remote path
// can be verified locally against a stub server without Azure creds.
// ===========================================================================

/** 'remote' only when remote mode is on AND that specialist has an endpoint; else 'local'. */
export function chooseTransport(agent, cfg = SPECIALISTS) {
  if (cfg.mode === "remote" && cfg.endpoints?.[agent]) return "remote";
  return "local";
}

/**
 * Invoke a specialist's Azure Function. Sends {agent, task}, expects {text}
 * (tolerates a plain-text body). Times out so a cold/hung Function can't wedge
 * the chief's tool loop. Returns the specialist's text.
 */
export async function invokeRemoteSpecialist(agent, task, { cfg = SPECIALISTS, fetchImpl = fetch, images } = {}) {
  const url = cfg.endpoints?.[agent];
  if (!url) throw new Error(`no remote endpoint configured for "${agent}"`);

  const key = cfg.keys?.[agent] || cfg.functionKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "x-functions-key": key } : {}),
      },
      // images (base64 Claude image blocks) ride along only when the turn had photos.
      body: JSON.stringify(images?.length ? { agent, task, images } : { agent, task }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`specialist "${agent}" returned HTTP ${res.status}`);
    const ct = res.headers?.get?.("content-type") || "";
    // Contract is {text, requests} (workstream S step 2). Tolerate a bare string /
    // plain-text body for back-compat, defaulting requests to []. requests carries
    // a COO's emitted requests back to Lloyd; a plain specialist returns [].
    if (ct.includes("application/json")) {
      const data = await res.json();
      if (typeof data === "string") return { text: data, requests: [] };
      return { text: data.text ?? "", requests: Array.isArray(data.requests) ? data.requests : [] };
    }
    return { text: await res.text(), requests: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a specialist through whichever transport config selects. Remote failures
 * do NOT silently fall back to local: running a remote specialist's work on
 * Lloyd would break the isolation guarantee, so we surface a short error string
 * the chief can relay instead. (localRunner is injectable for tests.)
 */
export async function delegate({ agent, task, images }, { cfg = SPECIALISTS, fetchImpl = fetch, localRunner = runSpecialist } = {}) {
  if (chooseTransport(agent, cfg) === "remote") {
    try {
      return await invokeRemoteSpecialist(agent, task, { cfg, fetchImpl, images });
    } catch (err) {
      log.error("remote specialist failed", { agent, error: String(err?.message || err) });
      return { text: `I could not reach the ${agent} specialist just now. Try again shortly.`, requests: [] };
    }
  }
  return localRunner(agent, task, { images });
}
