// Voice tile server (P1). A small HTTP server the daemon runs on localhost and
// exposes publicly via Tailscale Funnel. It serves the PWA (web/voice/) and a
// token-gated POST /voice: the phone records mic audio, we transcribe it (Azure
// STT), run Lloyd's FULL brain via handleInbound (so memory, triage, the
// confirmation gate all apply), synthesize the reply (Azure TTS), and return the
// transcript + reply text + spoken audio. Refuses to start without a token — an
// unauthenticated public line to Lloyd would be unsafe.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { VOICE } from "./config.js";
import { handleInbound } from "./orchestrator.js";
import { transcribeAudio } from "./audio.js";
import { synthesizeSpeech } from "./tts.js";
import { createLogger } from "./log.js";

const log = createLogger("voice-server");
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "voice");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".webmanifest": "application/manifest+json", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on("data", (c) => { n += c.length; if (n > limit) { req.destroy(); reject(new Error("too large")); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[\\/])+/, "");
  const file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch { res.writeHead(404).end("not found"); }
}

function authed(req, url) {
  const t = url.searchParams.get("k") || req.headers["x-voice-token"];
  return Boolean(VOICE.token) && t === VOICE.token;
}

// A short spoken "thinking" filler (Lloyd's Azure voice), synthesized once and
// cached in memory. The tile pre-fetches it and plays it the instant you stop
// talking, so a slow (Graph/model) turn doesn't feel like dead silence.
let _fillerCache;
async function serveFiller(res) {
  if (_fillerCache === undefined) {
    const a = await synthesizeSpeech(process.env.VOICE_FILLER_TEXT || "One moment.");
    _fillerCache = a ? a.bytes : null;
  }
  if (!_fillerCache) { res.writeHead(204).end(); return; }
  res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" });
  res.end(_fillerCache);
}

async function handleVoice(req, res, url) {
  if (!authed(req, url)) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
  const contentType = req.headers["content-type"] || "audio/mp4";
  let body;
  try { body = await readBody(req); } catch { res.writeHead(413).end(); return; }
  if (!body?.length) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "empty request" })); return; }

  // Two input modes: JSON { text, speak } for typed input (quiet mode, skips STT),
  // or a raw audio body for voice. `speak` defaults true for voice, false for text.
  let transcript = "";
  let speak = true;
  if (contentType.includes("application/json")) {
    let j; try { j = JSON.parse(body.toString("utf8") || "{}"); } catch { j = {}; }
    transcript = String(j.text || "").trim();
    speak = j.speak === true; // typed input is silent unless the client asks to hear it
    if (!transcript) { res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no text" })); return; }
  } else {
    transcript = await transcribeAudio({ bytes: body, contentType, name: "voice.m4a" });
    if (!transcript) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ transcript: "", reply: "Sorry, I couldn't make that out. Try again?", audio: null }));
      return;
    }
  }

  // Run Lloyd's full pipeline with a capturing transport (no channel send).
  let reply = "";
  const transport = { reply: async (t) => { reply = String(t ?? ""); }, mirror: async () => {} };
  try {
    await handleInbound({ from: VOICE.from, body: transcript, channel: "voice" }, transport);
  } catch (err) {
    log.error("voice turn failed", { reason: String(err?.message || err) });
    reply = reply || "Something went wrong on my end. Try again in a moment.";
  }
  const audio = speak ? await synthesizeSpeech(reply) : null;
  log.info("voice turn", { chars: transcript.length, replyChars: reply.length, mode: contentType.includes("application/json") ? "text" : "voice", spoke: !!audio });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ transcript, reply, audio: audio ? audio.bytes.toString("base64") : null, audioType: audio?.contentType || null }));
}

let _server = null;
export function startVoiceServer() {
  if (!VOICE.enabled) { log.info("voice server disabled (set COS_VOICE_SERVER=true)"); return null; }
  if (!VOICE.token) { log.warn("voice server NOT started: VOICE_TOKEN unset (refusing an unauthenticated voice line)"); return null; }
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, "http://localhost"); } catch { res.writeHead(400).end(); return; }
    if (req.method === "POST" && url.pathname === "/voice") {
      handleVoice(req, res, url).catch((e) => { log.error("voice handler error", { reason: String(e?.message || e) }); try { res.writeHead(500).end(); } catch {} });
      return;
    }
    if (req.method === "GET" && url.pathname === "/filler") {
      serveFiller(res).catch(() => { try { res.writeHead(500).end(); } catch {} });
      return;
    }
    if (req.method === "GET") {
      serveStatic(res, url.pathname).catch(() => { try { res.writeHead(500).end(); } catch {} });
      return;
    }
    res.writeHead(405).end();
  });
  server.on("error", (e) => log.error("voice server error", { reason: String(e?.message || e) }));
  server.listen(VOICE.port, "127.0.0.1", () => log.info("voice server listening", { port: VOICE.port }));
  _server = server;
  return server;
}

export function stopVoiceServer(server = _server) { try { server?.close(); } catch {} }
