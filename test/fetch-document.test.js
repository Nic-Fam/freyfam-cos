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

// Hermetic resolver: example.com is public. Injected so tests never hit real DNS.
const publicResolve = async () => [{ address: "93.184.216.34", family: 4 }];

test("fetchDocument parses a fetched .ics (routes through extractDocuments)", async () => {
  const ICS = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Parent night\r\nDTSTART:20260701T230000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";
  const r = await fetchDocument("https://example.com/cal.ics", {
    fetchImpl: async () => resp({ contentType: "text/calendar", body: ICS }),
    resolve: publicResolve,
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
    resolve: publicResolve,
  });
  assert.equal(r.blocks.length, 0);
  assert.match(r.skipped[0].reason, /404/);
});

test("fetchDocument surfaces a fetch failure as skipped", async () => {
  const r = await fetchDocument("https://example.com/x.pdf", {
    fetchImpl: async () => { throw new Error("network down"); },
    resolve: publicResolve,
  });
  assert.equal(r.blocks.length, 0);
  assert.match(r.skipped[0].reason, /network down/);
});

test("fetchDocument refuses a loopback/metadata target (SSRF guard) without fetching", async () => {
  let fetched = false;
  const spyFetch = async () => { fetched = true; return resp({}); };
  for (const url of ["http://127.0.0.1:8787/", "http://169.254.169.254/latest/meta-data/", "http://localhost/x.pdf"]) {
    const r = await fetchDocument(url, { fetchImpl: spyFetch });
    assert.equal(r.blocks.length, 0, `${url} must be blocked`);
    assert.match(r.skipped[0].reason, /private|loopback|link-local/i);
  }
  assert.equal(fetched, false, "the guard must run before any fetch");
});

test("fetchDocument refuses a name that resolves to a private address", async () => {
  const r = await fetchDocument("https://sneaky.example/x.pdf", {
    fetchImpl: async () => resp({}),
    resolve: async () => [{ address: "10.0.0.5", family: 4 }],
  });
  assert.equal(r.blocks.length, 0);
  assert.match(r.skipped[0].reason, /resolves to a private/i);
});
