import { test } from "node:test";
import assert from "node:assert";
import { fetchInboundMedia } from "../src/media.js";

// A stub fetch that serves canned string content per URL as an exactly-sized
// ArrayBuffer (mirroring real fetch().arrayBuffer()).
function stubFetch(map) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (!(url in map)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const u8 = new TextEncoder().encode(map[url]);
    return { ok: true, status: 200, arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) };
  };
  impl.calls = calls;
  return impl;
}

const twilio = { accountSid: "AC123", authToken: "tok" };

test("supported image -> base64 image block with the right media_type", async () => {
  
  const fetchImpl = stubFetch({ "https://api.twilio.com/m/0": "PNGDATA" });
  const { imageBlocks, skipped } = await fetchInboundMedia(
    [{ url: "https://api.twilio.com/m/0", contentType: "image/png" }],
    { fetchImpl, twilio }
  );
  assert.equal(skipped.length, 0);
  assert.equal(imageBlocks.length, 1);
  assert.deepEqual(imageBlocks[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: Buffer.from("PNGDATA").toString("base64") },
  });
});

test("sends Twilio basic-auth header on the media fetch", async () => {
  const fetchImpl = stubFetch({ "u": "x" });
  await fetchInboundMedia([{ url: "u", contentType: "image/jpeg" }], { fetchImpl, twilio });
  const expected = "Basic " + Buffer.from("AC123:tok").toString("base64");
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, expected);
});

test("unsupported types and HTTP errors are skipped, not fatal", async () => {
  const fetchImpl = stubFetch({ "ok": "img" }); // "bad" url 404s
  const { imageBlocks, skipped } = await fetchInboundMedia(
    [
      { url: "vcard", contentType: "text/vcard" },        // unsupported
      { url: "bad", contentType: "image/png" },           // 404
      { url: "ok", contentType: "image/webp" },           // good
    ],
    { fetchImpl, twilio }
  );
  assert.equal(imageBlocks.length, 1, "only the good image survives");
  assert.equal(imageBlocks[0].source.media_type, "image/webp");
  assert.ok(skipped.some((s) => s.reason === "unsupported type"));
  assert.ok(skipped.some((s) => /HTTP 404/.test(s.reason)));
});

test("content-type with charset suffix is normalized", async () => {
  const fetchImpl = stubFetch({ "u": "x" });
  const { imageBlocks } = await fetchInboundMedia([{ url: "u", contentType: "image/JPEG; charset=binary" }], { fetchImpl, twilio });
  assert.equal(imageBlocks[0]?.source.media_type, "image/jpeg");
});

test("empty / missing media is a no-op", async () => {
  assert.deepEqual(await fetchInboundMedia([], { twilio }), { imageBlocks: [], skipped: [] });
  assert.deepEqual(await fetchInboundMedia(undefined, { twilio }), { imageBlocks: [], skipped: [] });
});
