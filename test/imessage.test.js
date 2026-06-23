import { test } from "node:test";
import assert from "node:assert";
import { transportFor } from "../src/orchestrator.js";
import { normalizeBlueBubbles } from "../src/channels/imessage-inbound.js";

test("transportFor routes imessage to onImessage, preferring the chatGuid", async () => {
  const calls = [];
  const t = transportFor(
    { channel: "imessage", from: "+15551234567", replyTo: "iMessage;-;+15551234567" },
    { onImessage: (target, text) => calls.push([target, text]) }
  );
  await t.reply("on my way");
  assert.deepEqual(calls, [["iMessage;-;+15551234567", "on my way"]]);
});

test("imessage transport falls back to the raw handle when there's no chatGuid", async () => {
  const calls = [];
  const t = transportFor(
    { channel: "imessage", from: "shelli@icloud.com" },
    { onImessage: (target, text) => calls.push([target, text]) }
  );
  await t.reply("hi");
  assert.deepEqual(calls, [["shelli@icloud.com", "hi"]]);
});

test("imessage transport still exposes a safe no-op mirror", () => {
  const t = transportFor({ channel: "imessage", from: "+1", replyTo: "iMessage;-;+1" });
  assert.equal(typeof t.reply, "function");
  assert.equal(typeof t.mirror, "function");
  assert.doesNotThrow(() => t.mirror({ phase: "start" }));
});

test("normalizeBlueBubbles maps a new-message event to the inbound payload", () => {
  const norm = normalizeBlueBubbles({
    type: "new-message",
    data: {
      guid: "ABC-123",
      isFromMe: false,
      text: "whose haircut?",
      handle: { address: "+15551234567" },
      chats: [{ guid: "iMessage;-;+15551234567" }],
      attachments: [],
    },
  });
  assert.equal(norm.guid, "ABC-123");
  assert.deepEqual(norm.payload, {
    channel: "imessage",
    from: "+15551234567",
    replyTo: "iMessage;-;+15551234567",
    body: "whose haircut?",
    media: [],
  });
});

test("normalizeBlueBubbles ignores our own echoes, non-message events, and handleless events", () => {
  assert.equal(normalizeBlueBubbles({ type: "new-message", data: { isFromMe: true, handle: { address: "+1" } } }), null);
  assert.equal(normalizeBlueBubbles({ type: "typing-indicator", data: {} }), null);
  assert.equal(normalizeBlueBubbles({ type: "new-message", data: { text: "hi" } }), null); // no handle
  assert.equal(normalizeBlueBubbles(null), null);
});

test("normalizeBlueBubbles maps attachments into media blocks with a download url", () => {
  const norm = normalizeBlueBubbles({
    type: "new-message",
    data: {
      guid: "G2",
      handle: { address: "+1" },
      chats: [{ guid: "iMessage;-;+1" }],
      text: "",
      attachments: [
        { guid: "att-1", mimeType: "image/jpeg" },
        { guid: "bad" }, // no mimeType -> filtered out
      ],
    },
  });
  assert.equal(norm.payload.media.length, 1);
  assert.equal(norm.payload.media[0].contentType, "image/jpeg");
  assert.match(norm.payload.media[0].url, /\/api\/v1\/attachment\/att-1\/download\?password=/);
});
