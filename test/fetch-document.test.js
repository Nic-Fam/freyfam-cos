import { test } from "node:test";
import assert from "node:assert";
import { fetchDocument } from "../src/documents.js";

// Minimal Response-like stub for an injected fetch.
function resp({ ok = true, status = 200, contentType = "", body = "" }) {
  return {
    ok,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => Buffer.from(body),
  };
}

test("fetchDocument parses a fetched .ics (routes through extractDocuments)", async () => {
  const ICS = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Parent night\r\nDTSTART:20260701T230000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const r = await fetchDocument("https://example.com/cal.ics", {
    fetchImpl: async () => resp({ contentType: "text/calendar", body: ICS }),
  });
  assert.equal(r.blocks.length, 1);
  assert.match(r.blocks[0].text, /Parent night/);
});

test("fetchDocument rejects non-http(s) URLs", async () => {
  const r = await fetchDocument("file:///etc/passwd", { fetchImpl: async () => resp({}) });
  assert.equal(r.blocks.length, 0);
  assert.match(r.skipped[0].reason, /http/);
});

test("fetchDocument reports an HTTP error as skipped, not a throw", async () => {
  const r = await fetchDocument("https://example.com/missing.pdf", {
    fetchImpl: async () => resp({ ok: false, status: 404 }),
  });
  assert.equal(r.blocks.length, 0);
  assert.match(r.skipped[0].reason, /404/);
});

test("fetchDocument surfaces a fetch failure as skipped", async () => {
  const r = await fetchDocument("https://example.com/x.pdf", {
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.equal(r.blocks.length, 0);
  assert.match(r.skipped[0].reason, /network down/);
});
