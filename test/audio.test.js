import test from "node:test";
import assert from "node:assert";
import { isAudioAttachment, extractAudio, sttConfigured } from "../src/audio.js";
import { splitAttachmentsByKind } from "../src/orchestrator.js";

test("isAudioAttachment matches by content type and by extension", () => {
  assert.ok(isAudioAttachment({ contentType: "audio/mp4" }));
  assert.ok(isAudioAttachment({ contentType: "application/octet-stream", name: "voicemail.m4a" }));
  assert.ok(isAudioAttachment({ name: "note.amr" }));
  assert.ok(!isAudioAttachment({ contentType: "image/jpeg", name: "pic.jpg" }));
  assert.ok(!isAudioAttachment({ contentType: "application/pdf", name: "doc.pdf" }));
});

test("splitAttachmentsByKind routes audio away from images and docs", () => {
  const { imageAtts, audioAtts, docAtts } = splitAttachmentsByKind([
    { name: "pic.jpg", contentType: "image/jpeg", bytes: Buffer.from("x") },
    { name: "vm.m4a", contentType: "audio/mp4", bytes: Buffer.from("x") },
    { name: "doc.pdf", contentType: "application/pdf", bytes: Buffer.from("x") },
    { name: "mystery", contentType: "application/octet-stream", name: "clip.caf", bytes: Buffer.from("x") },
  ]);
  assert.deepEqual(imageAtts.map((a) => a.name), ["pic.jpg"]);
  assert.deepEqual(audioAtts.map((a) => a.name).sort(), ["clip.caf", "vm.m4a"]);
  assert.deepEqual(docAtts.map((a) => a.name), ["doc.pdf"]);
});

test("extractAudio turns transcribed audio into a text block", async () => {
  const transcribe = async ({ name }) => (name === "vm.m4a" ? "call me back at three" : null);
  const { blocks, summaries, skipped } = await extractAudio(
    [{ name: "vm.m4a", contentType: "audio/mp4", bytes: Buffer.from("x") },
     { name: "bad.m4a", contentType: "audio/mp4", bytes: Buffer.from("x") }],
    { transcribe }
  );
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /Voice note "vm\.m4a" — transcript/);
  assert.match(blocks[0].text, /call me back at three/);
  assert.equal(summaries.length, 1);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].name, "bad.m4a");
});

test("extractAudio skip reason names the missing STT config when unconfigured", async () => {
  const prevKey = process.env.AZURE_SPEECH_KEY, prevRegion = process.env.AZURE_SPEECH_REGION;
  delete process.env.AZURE_SPEECH_KEY; delete process.env.AZURE_SPEECH_REGION;
  try {
    assert.equal(sttConfigured(), false);
    const { blocks, skipped } = await extractAudio([{ name: "vm.m4a", contentType: "audio/mp4", bytes: Buffer.from("x") }]);
    assert.equal(blocks.length, 0);
    assert.match(skipped[0].reason, /STT not configured/);
  } finally {
    if (prevKey !== undefined) process.env.AZURE_SPEECH_KEY = prevKey;
    if (prevRegion !== undefined) process.env.AZURE_SPEECH_REGION = prevRegion;
  }
});
