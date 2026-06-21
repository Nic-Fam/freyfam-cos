import { createRequire } from "node:module";
import { createLogger } from "./log.js";

// ===========================================================================
// Inbound document intake (workstream L). Email attachments -> text the agent
// loop can read. Sibling to media.js (which turns MMS photos into vision blocks);
// this turns PDFs / calendar invites / contact cards into text blocks.
//
//   application/pdf            -> extracted text (lazy parser; skipped if absent)
//   text/calendar (.ics)       -> event summary (dependency-free parser)
//   text/vcard / x-vcard (.vcf)-> contact summary (dependency-free parser)
//   anything else              -> skipped (logged, non-fatal)
//
// Read-only and side-effect-light: parsing a document never sends anything. Any
// resulting outbound still goes through Lloyd's confirm gate + guards.
// ===========================================================================

const log = createLogger("documents");

const MAX_DOCS = Number(process.env.DOC_MAX_DOCS || 5);
const MAX_CHARS = Number(process.env.DOC_MAX_CHARS || 8000); // per doc; keeps token cost bounded

const norm = (ct) => String(ct || "").toLowerCase().split(";")[0].trim();

function cap(text) {
  const t = String(text || "").trim();
  return t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + `\n…[truncated at ${MAX_CHARS} chars]` : t;
}

// RFC5545/6350 line unfolding: a line starting with space/tab continues the prior.
function unfold(raw) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
}

// "KEY;PARAM=x:VALUE" -> { key:"KEY", value:"VALUE" }
function propOf(line) {
  const i = line.indexOf(":");
  if (i < 0) return null;
  return { key: line.slice(0, i).split(";")[0].toUpperCase(), value: line.slice(i + 1).trim() };
}

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") cur = { attendees: [] };
    else if (line === "END:VEVENT") {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) {
      const p = propOf(line);
      if (!p) continue;
      if (p.key === "SUMMARY") cur.summary = p.value;
      else if (p.key === "DTSTART") cur.start = p.value;
      else if (p.key === "DTEND") cur.end = p.value;
      else if (p.key === "LOCATION") cur.location = p.value;
      else if (p.key === "ORGANIZER") cur.organizer = p.value.replace(/^mailto:/i, "");
      else if (p.key === "ATTENDEE") cur.attendees.push(p.value.replace(/^mailto:/i, ""));
    }
  }
  const lines = events.map((e) => {
    const parts = [`Event: ${e.summary || "(untitled)"}`];
    if (e.start) parts.push(`start ${e.start}${e.end ? ` – ${e.end}` : ""}`);
    if (e.location) parts.push(`@ ${e.location}`);
    if (e.attendees.length) parts.push(`attendees: ${e.attendees.join(", ")}`);
    return parts.join(" | ");
  });
  return { kind: "calendar", events, text: lines.join("\n"), summary: `${events.length} calendar event(s)` };
}

export function parseVcard(text) {
  const contacts = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (line.toUpperCase() === "BEGIN:VCARD") cur = { tel: [], email: [] };
    else if (line.toUpperCase() === "END:VCARD") {
      if (cur) contacts.push(cur);
      cur = null;
    } else if (cur) {
      const p = propOf(line);
      if (!p) continue;
      if (p.key === "FN") cur.name = p.value;
      else if (p.key === "ORG") cur.org = p.value.replace(/;/g, " ").trim();
      else if (p.key === "TEL") cur.tel.push(p.value);
      else if (p.key === "EMAIL") cur.email.push(p.value);
    }
  }
  const lines = contacts.map((c) => {
    const parts = [`Contact: ${c.name || "(no name)"}`];
    if (c.org) parts.push(`org: ${c.org}`);
    if (c.tel.length) parts.push(`tel: ${c.tel.join(", ")}`);
    if (c.email.length) parts.push(`email: ${c.email.join(", ")}`);
    return parts.join(" | ");
  });
  return { kind: "contact", contacts, text: lines.join("\n"), summary: `${contacts.length} contact(s)` };
}

// PDF needs a binary parser (pdf-parse v1, the classic `pdf(buffer) -> {text}` API).
// Loaded lazily so the daemon/tests run without it; if it's not installed we skip
// the attachment (logged) rather than crash. We use createRequire, NOT import():
// pdf-parse v1's index runs a debug block that reads a test file when loaded as an
// ES module (no module.parent), which throws. require() sets module.parent and
// skips that block. `importer` stays injectable for tests.
export async function parsePdf(bytes, { importer } = {}) {
  let pdfParse;
  try {
    if (importer) {
      const mod = await importer();
      pdfParse = mod.default || mod;
    } else {
      const require = createRequire(import.meta.url);
      pdfParse = require("pdf-parse");
    }
  } catch {
    return null; // parser not installed -> caller skips
  }
  if (typeof pdfParse !== "function") return null;
  const out = await pdfParse(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  return { kind: "pdf", text: out.text || "", summary: `PDF${out.numpages ? `, ${out.numpages}pp` : ""}` };
}

/**
 * Turn email attachments into text content blocks for the agent loop.
 * @param {{name?:string, contentType?:string, bytes:Buffer|Uint8Array}[]} attachments
 * @returns {Promise<{blocks:{type:'text',text:string}[], summaries:string[], skipped:object[]}>}
 */
export async function extractDocuments(attachments = [], { pdfImporter } = {}) {
  const blocks = [];
  const summaries = [];
  const skipped = [];
  if (!Array.isArray(attachments) || !attachments.length) return { blocks, summaries, skipped };

  for (const att of attachments.slice(0, MAX_DOCS)) {
    const ct = norm(att?.contentType);
    const name = att?.name || "attachment";
    try {
      let parsed = null;
      if (ct === "application/pdf") parsed = await parsePdf(att.bytes, { importer: pdfImporter });
      else if (ct === "text/calendar") parsed = parseIcs(Buffer.from(att.bytes).toString("utf8"));
      else if (ct === "text/vcard" || ct === "text/x-vcard") parsed = parseVcard(Buffer.from(att.bytes).toString("utf8"));

      if (!parsed) {
        skipped.push({ name, contentType: ct, reason: ct === "application/pdf" ? "pdf parser not installed" : "unsupported type" });
        continue;
      }
      blocks.push({ type: "text", text: `[Attachment: ${name}]\n${cap(parsed.text)}` });
      summaries.push(`${name}: ${parsed.summary}`);
    } catch (err) {
      skipped.push({ name, contentType: ct, reason: err.message });
    }
  }
  if (attachments.length > MAX_DOCS) skipped.push({ reason: `capped at ${MAX_DOCS} documents` });
  if (skipped.length) log.warn("skipped inbound documents", { kept: blocks.length, skipped });
  return { blocks, summaries, skipped };
}

const FETCH_TIMEOUT_MS = Number(process.env.DOC_FETCH_TIMEOUT_MS || 25000);
const MAX_FETCH_BYTES = Number(process.env.DOC_MAX_FETCH_BYTES || 15_000_000);

/**
 * Fetch a document at a URL (PDF/.ics/.vcf) and parse it through the same path as
 * an attachment. For links that arrive in an email body — e.g. a Bright Horizons
 * curriculum PDF (those media URLs are public direct-fetch, no auth). Read-only:
 * http(s) only, timeout, size cap. Returns the same shape as extractDocuments.
 */
export async function fetchDocument(url, { fetchImpl = fetch } = {}) {
  const u = String(url || "");
  const empty = { blocks: [], summaries: [], skipped: [] };
  if (!/^https?:\/\//i.test(u)) return { ...empty, skipped: [{ url: u, reason: "only http(s) URLs allowed" }] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(u, { signal: controller.signal });
    if (!res.ok) return { ...empty, skipped: [{ url: u, reason: `HTTP ${res.status}` }] };
    const len = Number(res.headers?.get?.("content-length") || 0);
    if (len && len > MAX_FETCH_BYTES) return { ...empty, skipped: [{ url: u, reason: `too large (${len}B)` }] };
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_FETCH_BYTES) return { ...empty, skipped: [{ url: u, reason: `too large (${bytes.length}B)` }] };
    const contentType = res.headers?.get?.("content-type") || "";
    const name = u.split("?")[0].split("/").filter(Boolean).slice(-2).join("/") || "document";
    return extractDocuments([{ name, contentType, bytes }]);
  } catch (err) {
    return { ...empty, skipped: [{ url: u, reason: err.message }] };
  } finally {
    clearTimeout(timer);
  }
}
