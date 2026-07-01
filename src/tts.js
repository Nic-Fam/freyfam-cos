// Text-to-speech for audible replies (Tier 1 voice). Lloyd's text answer is
// synthesized to an MP3 via Azure Speech neural TTS (the SAME freyfam-speech
// resource that powers inbound transcription — no new vendor, negligible cost) and
// sent back as an audio message on the channel the family used. Best-effort:
// returns null on any failure / when unconfigured, so a TTS hiccup never blocks the
// text reply that always goes out alongside it.

import { createLogger } from "./log.js";

const log = createLogger("tts");

const VOICE = process.env.TTS_VOICE || "en-US-AndrewNeural";
const FORMAT = process.env.TTS_FORMAT || "audio-24khz-48kbitrate-mono-mp3";
const MAX_TTS_CHARS = Number(process.env.TTS_MAX_CHARS || 4000);

const ssmlEscape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

/** Speak-friendly cleanup: drop markdown emphasis + turn [label](url) into label. */
export function forSpeech(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#>]/g, "")
    .replace(/\n{2,}/g, ". ")
    .trim();
}

/** True when Azure Speech (also used for TTS) is configured. */
export function ttsConfigured() {
  return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

/**
 * Synthesize speech from text. Returns { bytes:Buffer, contentType, ext } or null.
 * fetchImpl is injectable for tests.
 */
export async function synthesizeSpeech(text, { voice = VOICE, fetchImpl = fetch } = {}) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) { log.warn("tts skipped: not configured"); return null; }
  const clean = forSpeech(text);
  if (!clean) return null;
  const body = clean.length > MAX_TTS_CHARS ? clean.slice(0, MAX_TTS_CHARS) : clean;
  const ssml = `<speak version="1.0" xml:lang="en-US"><voice name="${voice}">${ssmlEscape(body)}</voice></speak>`;
  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": FORMAT,
        "User-Agent": "freyfam-cos",
      },
      body: ssml,
    });
    if (!res.ok) { log.error("azure tts error", { status: res.status }); return null; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    log.info("synthesized speech", { chars: body.length, bytes: buf.length, voice });
    return { bytes: buf, contentType: "audio/mpeg", ext: "mp3" };
  } catch (err) {
    log.error("tts failed", { reason: String(err?.message || err) });
    return null;
  }
}
