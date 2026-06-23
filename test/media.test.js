import { test } from "node:test";
import assert from "node:assert";
import { fetchInboundMedia, sniffImageType } from "../src/media.js";

// Real magic-number prefixes for the four types Claude accepts.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP")]);
// iPhone HEIC: ISO-BMFF "ftyp" box with a heic brand. Claude can't read it.
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(8)]);

// A stub fetch that serves canned content per URL as an exactly-sized
// ArrayBuffer (mirroring real fetch().arrayBuffer()). String values are encoded;
// Buffer values (real image magic bytes) are served as-is.
function stubFetch(map) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (!(url in map)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const v = map[url];
    const u8 = Buffer.isBuffer(v) ? v : new TextEncoder().encode(v);
    return { ok: true, status: 200, arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) };
  };
  impl.calls = calls;
  return impl;
}

const twilio = { accountSid: "AC123", authToken: "tok" };

test("supported image -> base64 image block with media_type from the bytes", async () => {
  const fetchImpl = stubFetch({ "https://api.twilio.com/m/0": PNG });
  const { imageBlocks, skipped } = await fetchInboundMedia(
    [{ url: "https://api.twilio.com/m/0", contentType: "image/png" }],
    { fetchImpl, twilio }
  );
  assert.equal(skipped.length, 0);
  assert.equal(imageBlocks.length, 1);
  assert.deepEqual(imageBlocks[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") },
  });
});

test("sends Twilio basic-auth header on the media fetch", async () => {
  const fetchImpl = stubFetch({ "u": "x" });
  await fetchInboundMedia([{ url: "u", contentType: "image/jpeg" }], { fetchImpl, twilio });
  const expected = "Basic " + Buffer.from("AC123:tok").toString("base64");
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, expected);
});

test("unsupported types and HTTP errors are skipped, not fatal", async () => {
  const fetchImpl = stubFetch({ "ok": WEBP }); // "bad" url 404s
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

test("content-type with charset suffix passes the gate; media_type comes from bytes", async () => {
  const fetchImpl = stubFetch({ "u": JPEG });
  const { imageBlocks } = await fetchInboundMedia([{ url: "u", contentType: "image/JPEG; charset=binary" }], { fetchImpl, twilio });
  assert.equal(imageBlocks[0]?.source.media_type, "image/jpeg");
});

test("HEIC (iPhone) is skipped with an actionable reason, never sent", async () => {
  // Declared image/jpeg (as Slack/Messages mislabel it) but the bytes are HEIC.
  // Sending it 400s the whole turn, so it must be skipped, not gambled.
  const { imageBlocks, skipped } = await fetchInboundMedia([{ bytes: HEIC, contentType: "image/jpeg" }], { twilio });
  assert.equal(imageBlocks.length, 0);
  assert.match(skipped[0].reason, /HEIC/);
});

test("bytes that aren't a supported image are skipped, not sent on the declared type", async () => {
  const { imageBlocks, skipped } = await fetchInboundMedia([{ bytes: Buffer.from("garbage not an image"), contentType: "image/png" }], { twilio });
  assert.equal(imageBlocks.length, 0);
  assert.match(skipped[0].reason, /unrecognized/);
});

test("sniffImageType reads the type from the bytes, not the name", () => {
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(WEBP), "image/webp");
  assert.equal(sniffImageType(Buffer.from("not an image")), null);
});

test("declared type that disagrees with the bytes is corrected (Slack jpeg-named-png)", async () => {
  // Slack hands us bytes that are really PNG but a mimetype of image/jpeg. A
  // mismatched media_type makes Claude 400 with "Could not process image", so
  // the block must carry the SNIFFED type.
  const { imageBlocks, skipped } = await fetchInboundMedia([{ bytes: PNG, contentType: "image/jpeg" }], { twilio });
  assert.equal(skipped.length, 0);
  assert.equal(imageBlocks[0]?.source.media_type, "image/png");
});

test("empty / missing media is a no-op", async () => {
  assert.deepEqual(await fetchInboundMedia([], { twilio }), { imageBlocks: [], skipped: [] });
  assert.deepEqual(await fetchInboundMedia(undefined, { twilio }), { imageBlocks: [], skipped: [] });
});
