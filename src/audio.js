// Inbound AUDIO intake: transcribe voice notes / voicemails that arrive as
// attachments (email via Graph, Slack file uploads, iMessage/BlueBubbles), so the
// normal agent turn can read them. Claude's Messages API takes text + images but
// NOT audio, so a speech-to-text step runs first. Ported from the legacy
// freyfam-assistant voicemail path; provider is Azure AI Speech Fast Transcription
// (fits the family's Azure tenant/billing). Best-effort: any failure or missing
// config returns null and the caller skips (logged) — audio never breaks a message.
//
// Activation: set AZURE_SPEECH_KEY + AZURE_SPEECH_REGION. Until then the path is
// inert and a voice note is surfaced as "couldn't transcribe (STT not configured)".

import { createLogger } from "./log.js";

const log = createLogger("audio");

// iPhone "Share voice memo/voicemail" => .m4a (AAC); carrier visual voicemail is
// often .amr. Accept common phone-audio containers by MIME or filename extension
// (some forwarders send application/octet-stream with only the name as a signal).
const AUDIO_EXT = /\.(m4a|mp3|amr|wav|ogg|oga|aac|opus|caf|3gp|3gpp|webm|flac)$/i;
const MAX_AUDIO_BYTES = Number(process.env.AUDIO_MAX_BYTES || 24 * 1024 * 1024);
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.AUDIO_TRANSCRIBE_TIMEOUT_MS || 120_000);

/** True when an attachment looks like audio (by content type or filename). Pure. */
export function isAudioAttachment(att) {
  const ct = String(att?.contentType || "").toLowerCase();
  if (ct.startsWith("audio/")) return true;
  return AUDIO_EXT.test(att?.name || "");
}

/** True when a speech-to-text provider is configured. */
export function sttConfigured() {
  return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

/**
 * Transcribe one audio attachment via Azure AI Speech Fast Transcription.
 * Best-effort: returns the transcript string, or null on any failure / when
 * unconfigured (never throws into the agent turn). `bytes` may be a Buffer or a
 * base64 string. fetchImpl is injectable for tests.
 */
export async function transcribeAudio({ bytes, contentType, name } = {}, { fetchImpl = fetch } = {}) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) { log.warn("audio skipped: STT not configured", { name }); return null; }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || "", "base64");
  if (!buf.length) return null;
  if (buf.length > MAX_AUDIO_BYTES) { log.warn("audio too large, skipped", { name, bytes: buf.length }); return null; }

  const url = `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;
  const form = new FormData();
  form.append("audio", new Blob([buf], { type: contentType || "application/octet-stream" }), name || "audio");
  form.append("definition", JSON.stringify({ locales: ["en-US"] }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": key }, body: form, signal: controller.signal });
    if (!res.ok) { log.error("Azure Speech error", { status: res.status, name }); return null; }
    const json = await res.json();
    const text = (json.combinedPhrases?.[0]?.text || "").trim();
    if (!text) { log.warn("empty transcript", { name }); return null; }
    log.info("transcribed audio", { name, chars: text.length });
    return text;
  } catch (err) {
    log.error("transcribe failed", { name, reason: String(err?.message || err) });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turn audio attachments into text blocks for the agent turn (mirrors
 * documents.extractDocuments). Returns { blocks, summaries, skipped }. `transcribe`
 * is injectable for tests.
 */
export async function extractAudio(attachments = [], { transcribe = transcribeAudio } = {}) {
  const blocks = [];
  const summaries = [];
  const skipped = [];
  for (const att of Array.isArray(attachments) ? attachments : []) {
    const name = att?.name || "voice note";
    let text = null;
    try {
      text = await transcribe({ bytes: att?.bytes ?? att?.contentBytes, contentType: att?.contentType, name });
    } catch (err) {
      log.error("extractAudio transcribe threw", { name, reason: String(err?.message || err) });
    }
    if (!text) {
      skipped.push({ name, reason: sttConfigured() ? "transcription failed or empty" : "STT not configured (set AZURE_SPEECH_KEY + AZURE_SPEECH_REGION)" });
      continue;
    }
    blocks.push({ type: "text", text: `[Voice note "${name}" — transcript]\n${text}` });
    summaries.push(`${name}: voice note transcribed (${text.length} chars)`);
  }
  return { blocks, summaries, skipped };
}
