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
import { createHash, timingSafeEqual } from "node:crypto";
import { VOICE } from "./config.js";
import { handleInbound } from "./orchestrator.js";
import { transcribeAudio } from "./audio.js";
import { synthesizeSpeech } from "./tts.js";
import { addTodoTask } from "./channels/graph.js";
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
  // Prefer the header; the ?k= query param is a fallback (it leaks into URLs/logs)
  // for the audio <source> tags that can't set headers. Compared in constant time.
  const t = req.headers["x-voice-token"] || url.searchParams.get("k");
  if (!VOICE.token) return false;
  const a = createHash("sha256").update(String(t ?? "")).digest();
  const b = createHash("sha256").update(String(VOICE.token)).digest();
  return timingSafeEqual(a, b);
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
   "basically really very about into onto up if when while where how what too " +
   // linking / auxiliary / modal verbs — very common trail-off points ("...we will be", "...it is")
   "be been being is are am was were will would could should can may might must do does did " +
   "have has had").split(" ")
);
function endsHanging(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/[,\-…]$/.test(t) || /\.\.\.$/.test(t)) return true; // trailing comma / dash / ellipsis
  // NB: do NOT treat a trailing period as "done" — Azure STT auto-punctuates almost
  // every segment, so we judge purely by the last spoken word (punctuation stripped).
  const last = (t.toLowerCase().match(/[a-z']+/g) || []).pop();
  return last ? CONT_WORDS.has(last) : false;
}

// Explicit "I'm done" sign-off so you can end a long, pause-heavy request on demand
// (radio-style "over") instead of waiting for the silence timer. Matched + stripped
// from the tail so it never reaches the model.
const FINISH_RE = /[\s,]*\b(?:over and out|over|that'?s (?:it|all)|that is all|go ahead|send it|send now|send that|i'?m done|(?:i am )?done|the end|end of message)\b[\s.!?]*$/i;
function endsFinish(text) { return FINISH_RE.test(String(text || "").trim()); }
function stripFinish(text) { return String(text || "").replace(FINISH_RE, "").replace(/\s+/g, " ").trim(); }

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

  // wake gating applies whenever the tile asks for it (?wake=1). It's used only by the
  // STT-phase and the legacy audio path below; typed input never sends wake=1, and the
  // on-device path sends its recognized TEXT here as JSON with stt=1&wake=1 so it reuses
  // the exact same wake / continuation / finish gate as the audio path.
  const wakeMode = url.searchParams.get("wake") === "1";
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
    const finish = endsFinish(command);
    const cmd = finish ? stripFinish(command) : command;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ transcript, accepted: true, command: cmd, continuation: !finish && endsHanging(cmd), finish }));
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

// Token-gated POST /list-add: a hands-free path into the same M365 shopping lists
// the grocery order flow reads (gatherGroceryItems). Siri's "restock {item}"
// Shortcut posts {store, item} here; Lloyd's add_todo_item tool is the same write.
// This ONLY appends to a named list (no browser, no purchase, nothing irreversible),
// so it does not need the confirmation gate. Store defaults to Ralphs and is
// clamped to the known lists so a typo can't spawn a stray list.
const LIST_STORES = new Set(["ralphs", "costco", "amazon shopping list"]);
async function handleListAdd(req, res, url) {
  const json = (code, obj) => { try { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); } catch {} };
  if (!authed(req, url)) return json(401, { error: "unauthorized" });
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString("utf8") || "{}"); }
  catch { return json(400, { error: "bad json" }); }
  const item = String(body.item ?? "").trim();
  let store = String(body.store ?? "Ralphs").trim();
  if (!item) return json(400, { error: "item is required" });
  if (!LIST_STORES.has(store.toLowerCase())) store = "Ralphs";
  try {
    const t = await addTodoTask(store, item);
    log.info("voice list-add", { store, item });
    return json(200, { ok: true, store, item: t.title });
  } catch (e) {
    log.error("voice list-add failed", { reason: String(e?.message || e) });
    return json(500, { error: "could not add the item" });
  }
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
    if (req.method === "POST" && url.pathname === "/list-add") {
      handleListAdd(req, res, url).catch((e) => { log.error("list-add handler error", { reason: String(e?.message || e) }); try { res.writeHead(500).end(); } catch {} });
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
