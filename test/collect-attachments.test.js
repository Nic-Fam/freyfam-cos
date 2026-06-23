import { test } from "node:test";
import assert from "node:assert";
import { collectAttachments } from "../src/orchestrator.js";

// A stub fetch that serves canned content per URL as a real-shaped arrayBuffer.
function stubFetch(map) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (!(url in map)) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    const u8 = new TextEncoder().encode(map[url]);
    return { ok: true, status: 200, arrayBuffer: async () => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) };
  };
  impl.calls = calls;
  return impl;
}

test("URL-based attachments (iMessage) are downloaded into bytes for the doc parser", async () => {
  const url = "http://bluebubbles.local/api/v1/attachment/att-vcf/download?password=x";
  const fetchImpl = stubFetch({ [url]: "BEGIN:VCARD\nFN:Jane\nEND:VCARD" });
  const out = await collectAttachments(
    { attachments: [{ name: "jane.vcf", contentType: "text/vcard", url }] },
    { fetchImpl }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "jane.vcf");
  assert.equal(out[0].contentType, "text/vcard");
  assert.ok(Buffer.isBuffer(out[0].bytes));
  assert.match(out[0].bytes.toString("utf8"), /FN:Jane/);
  assert.equal(fetchImpl.calls.length, 1);
});

test("already-downloaded bytes are used as-is (Slack/email path), no fetch", async () => {
  const fetchImpl = stubFetch({});
  const out = await collectAttachments(
    { attachments: [{ name: "a.pdf", contentType: "application/pdf", bytes: Buffer.from("PDF") }] },
    { fetchImpl }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].bytes.toString(), "PDF");
  assert.equal(fetchImpl.calls.length, 0);
});

test("a failed download is dropped, not fatal", async () => {
  const fetchImpl = stubFetch({}); // every URL 404s
  const out = await collectAttachments(
    { attachments: [{ name: "gone.pdf", contentType: "application/pdf", url: "http://x/none" }] },
    { fetchImpl }
  );
  assert.deepEqual(out, []);
});
