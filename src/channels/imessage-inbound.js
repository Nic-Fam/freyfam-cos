import http from "node:http";
import { handleInbound } from "../orchestrator.js";
import { isProcessed, markProcessed, unmarkProcessed } from "../processed-messages.js";
import { IMESSAGE } from "../config.js";
import { createLogger } from "../log.js";

// ===========================================================================
// Inbound iMessage. BlueBubbles (on the same Mac) POSTs a webhook for every new
// message; this tiny localhost-only HTTP server normalizes that event into the
// schemaless inbound payload the rest of the daemon already speaks
//   { channel, from, replyTo, body, media }
// and hands it to handleInbound — the same entry point the Azure queue uses for
// SMS/email. So iMessage rides ALL existing machinery (triage, the chief, the
// short-term thread, confirmations) for free.
//
// Why a direct listener instead of the Azure queue: iMessage is end-to-end
// local (BlueBubbles + this daemon on one machine), so routing through Azure
// would add a cloud round-trip and cost for a purely-local message. We keep the
// queue's important guarantee — at-least-once dedup — by reusing
// processed-messages keyed on the iMessage guid: BlueBubbles retries a webhook
// on any non-2xx, and a daemon restart mid-handle must not double-fire a "YES"
// approval. Mark-before-handle / unmark-on-failure mirrors queue.js exactly.
//
// Bound to 127.0.0.1 by default: never publicly reachable, same pull-only
// security property as the SMS queue and Slack socket.
// ===========================================================================

const log = createLogger("imessage-in");

/** True if `handle` is permitted to talk to the chief. Empty allowlist = open
 *  (parity with SMS, which any sender to the private number can reach). */
function isAllowed(handle) {
  if (!IMESSAGE.allow.length) return true;
  return IMESSAGE.allow.includes(String(handle || "").toLowerCase().trim());
}

/** Map a BlueBubbles new-message payload to our inbound shape. Returns null for
 *  anything we should ignore (our own echoes, empty/handleless events). */
export function normalizeBlueBubbles(evt) {
  if (!evt || evt.type !== "new-message") return null;
  const m = evt.data || {};
  if (m.isFromMe) return null;                       // don't react to our own sends
  const handle = m.handle?.address;                  // phone E.164 or Apple ID email
  if (!handle) return null;
  return {
    guid: m.guid,
    payload: {
      channel: "imessage",
      from: handle,
      replyTo: m.chats?.[0]?.guid,                   // chatGuid -> exact-thread reply
      body: m.text || "",
      media: (m.attachments || [])
        .filter((a) => a?.guid && a?.mimeType)
        .map((a) => ({
          url: `${IMESSAGE.serverUrl}/api/v1/attachment/${a.guid}/download?password=${encodeURIComponent(IMESSAGE.password)}`,
          contentType: a.mimeType,
        })),
    },
  };
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw;
}

export function startImessage({ onInbound = handleInbound } = {}) {
  if (!IMESSAGE.enabled) {
    log.info("imessage disabled (set IMESSAGE_SERVER_URL + IMESSAGE_PASSWORD to enable)");
    return null;
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    const raw = await readBody(req).catch(() => "");
    // Ack FAST and unconditionally: a slow/erroring 2xx would make BlueBubbles
    // retry and re-deliver. We dedup + process after acking; dedup is the safety
    // net for the rare crash-before-handle case.
    res.writeHead(200).end("ok");

    let norm;
    try {
      norm = normalizeBlueBubbles(JSON.parse(raw));
    } catch (e) {
      log.warn("bad webhook body", { reason: e.message });
      return;
    }
    if (!norm) return;

    const { guid, payload } = norm;
    if (!isAllowed(payload.from)) {
      log.info("ignoring iMessage from non-allowlisted handle", { from: payload.from });
      return;
    }
    if (guid && (await isProcessed(guid))) {
      log.info("skipping already-processed iMessage", { guid });
      return;
    }
    if (guid) await markProcessed(guid);

    try {
      await onInbound(payload);
    } catch (e) {
      if (guid) await unmarkProcessed(guid); // let a future webhook retry a transient failure
      log.error("handle failed", { reason: e.message, from: payload.from });
    }
  });

  server.on("error", (e) => log.error("listener error", { reason: e.message }));
  server.listen(IMESSAGE.listenPort, IMESSAGE.listenHost, () =>
    log.info("listening", { host: IMESSAGE.listenHost, port: IMESSAGE.listenPort })
  );
  return server;
}

export function stopImessage(server) {
  if (server) server.close();
}
