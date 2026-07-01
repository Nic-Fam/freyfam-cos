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

// Short spoken "thinking" fillers (Lloyd's Azure voice). The tile plays one the
// instant you stop talking so a slow (Graph/model) turn isn't dead silence;
// rotating the phrase keeps it from feeling robotic. Each is synthesized once, on
// first request, and cached in memory. GET /filler -> { count } manifest so the
// tile knows how many to preload; GET /filler?i=K -> the audio for phrase K.
// VOICE_FILLER_TEXT overrides the set (pipe-separated, e.g. "One sec.|On it.").
const FILLER_PHRASES = (process.env.VOICE_FILLER_TEXT || "")
  .split("|").map((s) => s.trim()).filter(Boolean);
if (!FILLER_PHRASES.length) FILLER_PHRASES.push(
  "One moment.", "Let me check on that.", "Good question, let me look.", "Give me a sec.",
  "On it.", "Let me think on that one.", "Hmm, let me pull that up.", "Working on it.",
  "Let me look into that.", "Sure, one sec."
);
const _fillerCache = new Array(FILLER_PHRASES.length); // index -> bytes | null | undefined
async function serveFiller(res, url) {
  const raw = url.searchParams.get("i");
  if (raw === null) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=86400" });
    res.end(JSON.stringify({ count: FILLER_PHRASES.length }));
    return;
  }
  const i = Math.max(0, Math.min(FILLER_PHRASES.length - 1, parseInt(raw, 10) || 0));
  if (_fillerCache[i] === undefined) {
    const a = await synthesizeSpeech(FILLER_PHRASES[i]);
    _fillerCache[i] = a ? a.bytes : null;
  }
  if (!_fillerCache[i]) { res.writeHead(204).end(); return; }
  res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400" });
  res.end(_fillerCache[i]);
}

// Wake-word matcher for the tile's "only answer when addressed" mode. Matches an
// optional lead-in ("hey/hi/ok/okay/yo") + Lloyd or a common STT mishearing, and
// strips that address off the front so the command that follows is what runs.
const WAKE_RE = /\b(?:hey|hi|ok|okay|yo)?\s*(?:lloyd|loyd|lloyds|floyd|lord)\b[\s,.:!?-]*/i;
function stripWake(text) { return String(text).replace(WAKE_RE, " ").replace(/\s+/g, " ").trim(); }

// "Are they mid-thought?" — a segment that trails off on a filler/conjunction/article
// (or a trailing comma/dash/ellipsis) means more is coming, so the tile keeps listening
// and appends the next segment instead of answering a fragment. Generous on purpose: a
// false "keep going" is caught by the tile's finalize timer, but a false "done" chops
// the sentence. Do NOT hang on a natural ending ("...on Saturday.").
const CONT_WORDS = new Set(
  ("uh um uhh umm er erm hmm ah eh mm and so but or nor because cause then plus also with " +
   "for to of in on at by as that which than the a an my your our their its this these those " +
   "some any like well just i we you it im lets need want going gonna wanna maybe actually " +
   "basically really very about into onto up if when while where how what " +
   // linking / auxiliary / modal verbs — very common trail-off points ("...we will be", "...it is")
   "be been being is are am was were will would could should can may might must do does did " +
   "have has had").split(" ")
);
function endsHanging(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/[,\-…]$/.test(t) || /\.\.\.$/.test(t)) return true; // trailing comma / dash / ellipsis
  if (/[.!?]$/.test(t)) return false;                          // a clean terminal ending = done
  const last = (t.toLowerCase().match(/[a-z']+/g) || []).pop();
  return last ? CONT_WORDS.has(last) : false;
}

// Recent completed turns, kept in memory so an answer computed while the tile was
// backgrounded (iOS suspends the page) is waiting as text when it returns to the
// foreground and calls GET /history. Text only + capped; not durable across a
// daemon restart (fine for a "what did I miss" catch-up).
const HISTORY_MAX = 50;
const _history = []; // { ts, transcript, reply }
function recordTurn(transcript, reply) {
  const r = String(reply || "").trim();
  if (!r) return 0;
  const ts = Date.now();
  _history.push({ ts, transcript: String(transcript || ""), reply: r });
  while (_history.length > HISTORY_MAX) _history.shift();
  return ts;
}
function serveHistory(req, res, url) {
  if (!authed(req, url)) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
  const since = Number(url.searchParams.get("since")) || 0;
  const turns = _history.filter((t) => t.ts > since);
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ now: Date.now(), turns }));
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

  const wakeMode = url.searchParams.get("wake") === "1" && !contentType.includes("application/json");
  const sttOnly = url.searchParams.get("stt") === "1";

  // Two-phase for voice: the tile first asks for STT only (?stt=1) so it can show
  // what Lloyd heard + apply the wake gate BEFORE the expensive model turn, then
  // POSTs the command back as JSON for the answer. This gives an immediate "heard
  // you" + a clear "thinking" state instead of dead air. STT is cheap; the model
  // turn + TTS is the costly part, so in a noisy cabin non-commands cost nothing.
  if (sttOnly) {
    if (wakeMode && !WAKE_RE.test(transcript)) {
      log.info("voice STT ignored (no wake word)", { chars: transcript.length });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ transcript, accepted: false }));
      return;
    }
    const command = wakeMode ? stripWake(transcript) : transcript;
    if (wakeMode && !command) {
      // Addressed by name with no command -> quick spoken "Yes?", no model call.
      const ack = await synthesizeSpeech("Yes?");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ transcript, accepted: true, command: "", reply: "Yes?", audio: ack ? ack.bytes.toString("base64") : null, audioType: ack?.contentType || null }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ transcript, accepted: true, command, continuation: endsHanging(command) }));
    return;
  }

  // Single-shot legacy path (audio without ?stt=1): keep the inline wake gate so an
  // older cached tile still works.
  if (wakeMode) {
    if (!WAKE_RE.test(transcript)) {
      log.info("voice turn ignored (no wake word)", { chars: transcript.length });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ignored: true, transcript }));
      return;
    }
    const stripped = stripWake(transcript);
    if (!stripped) {
      const ack = await synthesizeSpeech("Yes?");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ transcript, reply: "Yes?", audio: ack ? ack.bytes.toString("base64") : null, audioType: ack?.contentType || null }));
      return;
    }
    transcript = stripped;
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
  // Persist BEFORE responding so the answer survives even if the tile was
  // backgrounded and never receives this response (it fetches /history on return).
  const ts = recordTurn(transcript, reply);
  log.info("voice turn", { chars: transcript.length, replyChars: reply.length, mode: contentType.includes("application/json") ? "text" : "voice", spoke: !!audio });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ts, transcript, reply, audio: audio ? audio.bytes.toString("base64") : null, audioType: audio?.contentType || null }));
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
      serveFiller(res, url).catch(() => { try { res.writeHead(500).end(); } catch {} });
      return;
    }
    if (req.method === "GET" && url.pathname === "/history") {
      try { serveHistory(req, res, url); } catch { try { res.writeHead(500).end(); } catch {} }
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
