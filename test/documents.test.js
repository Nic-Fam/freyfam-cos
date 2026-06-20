import { test } from "node:test";
import assert from "node:assert";
import { parseIcs, parseVcard, parsePdf, extractDocuments } from "../src/documents.js";

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "SUMMARY:Soccer practice",
  "DTSTART:20260620T230000Z",
  "DTEND:20260621T000000Z",
  "LOCATION:Field 3",
  "ATTENDEE:mailto:coach@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const VCF = ["BEGIN:VCARD", "FN:Jane Coach", "ORG:Rec League", "TEL:+15551234567", "EMAIL:jane@example.com", "END:VCARD"].join(
  "\r\n"
);

test("parseIcs extracts event fields", () => {
  const r = parseIcs(ICS);
  assert.equal(r.events.length, 1);
  assert.match(r.text, /Soccer practice/);
  assert.match(r.text, /Field 3/);
  assert.match(r.text, /coach@example.com/);
});

test("parseVcard extracts contact fields", () => {
  const r = parseVcard(VCF);
  assert.equal(r.contacts.length, 1);
  assert.match(r.text, /Jane Coach/);
  assert.match(r.text, /\+15551234567/);
  assert.match(r.text, /jane@example.com/);
});

test("extractDocuments turns .ics/.vcf into text blocks + summaries", async () => {
  const { blocks, summaries, skipped } = await extractDocuments([
    { name: "invite.ics", contentType: "text/calendar", bytes: Buffer.from(ICS) },
    { name: "card.vcf", contentType: "text/x-vcard", bytes: Buffer.from(VCF) },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(skipped.length, 0);
  assert.match(blocks[0].text, /\[Attachment: invite.ics\]/);
  assert.ok(summaries.some((s) => /invite.ics/.test(s)));
});

test("extractDocuments skips unsupported types (non-fatal)", async () => {
  const { blocks, skipped } = await extractDocuments([
    { name: "thing.zip", contentType: "application/zip", bytes: Buffer.from("x") },
  ]);
  assert.equal(blocks.length, 0);
  assert.equal(skipped[0].reason, "unsupported type");
});

test("parsePdf returns null when no parser is available (graceful skip)", async () => {
  const r = await parsePdf(Buffer.from("%PDF-1.4"), { importer: () => Promise.reject(new Error("not installed")) });
  assert.equal(r, null);
});

test("extractDocuments routes a PDF through the injected parser", async () => {
  const fakePdf = () => Promise.resolve({ default: async () => ({ text: "Invoice total $42.00", numpages: 1 }) });
  const { blocks, summaries } = await extractDocuments([{ name: "inv.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF") }], {
    pdfImporter: fakePdf,
  });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].text, /Invoice total \$42\.00/);
  assert.match(summaries[0], /inv\.pdf: PDF, 1pp/);
});
