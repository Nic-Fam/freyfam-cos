import test from "node:test";
import assert from "node:assert";
import { synthesizeSpeech, ttsConfigured, forSpeech } from "../src/tts.js";
import { maybeVoiceReply } from "../src/orchestrator.js";

test("forSpeech strips markdown emphasis and link syntax", () => {
  assert.equal(forSpeech("**Hi** see [docs](http://x.com)"), "Hi see docs");
});

test("synthesizeSpeech returns audio bytes on success (mocked fetch)", async () => {
  const k = process.env.AZURE_SPEECH_KEY, r = process.env.AZURE_SPEECH_REGION;
  process.env.AZURE_SPEECH_KEY = "k"; process.env.AZURE_SPEECH_REGION = "westus2";
  try {
    const fetchImpl = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const out = await synthesizeSpeech("hello there", { fetchImpl });
    assert.ok(out && Buffer.isBuffer(out.bytes) && out.bytes.length === 3);
    assert.equal(out.contentType, "audio/mpeg");
  } finally { process.env.AZURE_SPEECH_KEY = k; process.env.AZURE_SPEECH_REGION = r; }
});

test("synthesizeSpeech is null when unconfigured", async () => {
  const k = process.env.AZURE_SPEECH_KEY, r = process.env.AZURE_SPEECH_REGION;
  delete process.env.AZURE_SPEECH_KEY; delete process.env.AZURE_SPEECH_REGION;
  try { assert.equal(await synthesizeSpeech("hi"), null); assert.equal(ttsConfigured(), false); }
  finally { if (k !== undefined) process.env.AZURE_SPEECH_KEY = k; if (r !== undefined) process.env.AZURE_SPEECH_REGION = r; }
});

test("maybeVoiceReply only fires on a voice-note turn and routes by channel", async () => {
  const calls = [];
  const deps = {
    configured: () => true,
    synth: async () => ({ bytes: Buffer.from("mp3"), contentType: "audio/mpeg" }),
    imessageAudio: async (t, a) => { calls.push(["imessage", a.contentType]); },
    voiceMail: async (o) => { calls.push(["email", o.to]); },
  };
  assert.equal(await maybeVoiceReply({ channel: "imessage", from: "+1" }, "hi", { hadVoiceNote: false, deps }), false);
  assert.equal(await maybeVoiceReply({ channel: "imessage", replyTo: "iMessage;-;+1", from: "+1" }, "hi", { hadVoiceNote: true, deps }), true);
  assert.equal(await maybeVoiceReply({ channel: "email", from: "nic@x.com", subject: "Q" }, "hi", { hadVoiceNote: true, deps }), true);
  assert.equal(await maybeVoiceReply({ channel: "slack", from: "U1" }, "hi", { hadVoiceNote: true, deps }), false);
  assert.deepEqual(calls.map((c) => c[0]), ["imessage", "email"]);
});

test("maybeVoiceReply respects COS_VOICE_REPLY=false", async () => {
  const prev = process.env.COS_VOICE_REPLY; process.env.COS_VOICE_REPLY = "false";
  try {
    const r = await maybeVoiceReply({ channel: "imessage", from: "x" }, "hi",
      { hadVoiceNote: true, deps: { configured: () => true, synth: async () => ({ bytes: Buffer.from("x"), contentType: "audio/mpeg" }) } });
    assert.equal(r, false);
  } finally { if (prev !== undefined) process.env.COS_VOICE_REPLY = prev; else delete process.env.COS_VOICE_REPLY; }
});
