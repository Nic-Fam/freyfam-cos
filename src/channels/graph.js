import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { GRAPH } from "../config.js";
import { registerApprovalNotifier } from "../confirm.js";
import { createLogger } from "../log.js";

const FAMILY_TZ = process.env.FAMILY_TZ || "America/Los_Angeles";

// Authoritative local weekday label for an event, computed in code so the model
// never derives day-of-week from a date itself -- it gets that wrong (e.g. it
// labeled Sat Jun 27 as "Friday", shifting availability onto the wrong day). The
// Graph dateTime is already family-local wall time (Prefer outlook.timezone), so
// its date part IS the local date; anchor that date at UTC noon and read the
// weekday in UTC to avoid any tz/DST edge (same trick grocery.js uses). Returns
// e.g. "Saturday, Jun 27", or undefined if the start isn't a parseable date.
export function localDayLabel(startStr) {
  const date = String(startStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(`${date}T12:00:00Z`));
}

// App-only auth (client credentials) against the assistant@freyfam.com mailbox.
let _client;
function graph() {
  if (_client) return _client;
  const credential = new ClientSecretCredential(
    GRAPH.tenantId,
    GRAPH.clientId,
    GRAPH.clientSecret
  );
  _client = Client.initWithMiddleware({
    authProvider: {
      getAccessToken: async () => {
        const token = await credential.getToken("https://graph.microsoft.com/.default");
        return token.token;
      },
    },
  });
  return _client;
}

/**
 * Cheap signal fetch for the heartbeat: recent message headers only.
 * Returns a compact array the triage model can scan without a full agent run.
 */
export async function recentMailSignals({ top = 15 } = {}) {
  const res = await graph()
    .api(`/users/${GRAPH.mailbox}/mailFolders/inbox/messages`)
    .top(top)
    .select("from,subject,receivedDateTime,isRead")
    .orderby("receivedDateTime desc")
    .get();
  return (res.value || []).map((m) => ({
    source: "email",
    from: m.from?.emailAddress?.address,
    subject: m.subject,
    receivedAt: m.receivedDateTime,
    unread: !m.isRead,
  }));
}

/**
 * Fetch file attachments for one message (workstream L: document intake). The
 * front door passes the `graphMessageId`; the daemon pulls the bytes via the
 * app-only Mail.Read it already has (no new consent). Returns materialized
 * {name, contentType, bytes} for `documents.extractDocuments`. Non-file
 * attachments (item/reference) are skipped.
 */
export async function fetchAttachments(messageId) {
  if (!messageId) return [];
  const res = await graph()
    .api(`/users/${GRAPH.mailbox}/messages/${messageId}/attachments`)
    .get();
  return (res.value || [])
    .filter((a) => a["@odata.type"] === "#microsoft.graph.fileAttachment" && a.contentBytes)
    .map((a) => ({
      name: a.name,
      contentType: a.contentType,
      bytes: Buffer.from(a.contentBytes, "base64"),
    }));
}

// --- Calendar (workstream: close the scheduling gap / Genet's "Claire") --------
// The real family schedule lives on the family members' OWN calendars (nic@ +
// shelli@), not on cos@. listEvents MERGES those (GRAPH.calendars) via
// calendarView over a date window so today's events and recurring instances
// actually appear (plain /events sorted oldest-first returned ancient events and
// skipped recurrences). App-only Calendars.ReadWrite reaches any tenant mailbox.
// New events are created on GRAPH.calendarWrite so they land where Lloyd reads.
// Creating an event sends invites, so it's high-stakes: the tool confirms first.

function toGraphDateTime(v) {
  if (v && typeof v === "object" && v.dateTime) return v; // already shaped
  return { dateTime: String(v), timeZone: FAMILY_TZ };
}

/** Pure: build the Graph event body. Exported for tests. */
export function buildEventPayload({ subject, start, end, attendees = [], location, body, showAs = "busy" }) {
  if (!subject) throw new Error("subject is required");
  if (!start) throw new Error("start is required");
  const payload = {
    subject,
    start: toGraphDateTime(start),
    end: toGraphDateTime(end || start),
    showAs, // "free" for House Cleaning etc. (house rule), else "busy"
    attendees: attendees.map((a) => ({
      emailAddress: { address: typeof a === "string" ? a : a.address },
      type: "required",
    })),
  };
  if (location) payload.location = { displayName: location };
  if (body) payload.body = { contentType: "Text", content: body };
  return payload;
}

// The UTC offset (e.g. "-07:00" PDT, "-08:00" PST) in FAMILY_TZ on a given
// calendar date. DST-aware: derived from the IANA zone via Intl, computed at
// noon UTC of that date (still the same calendar day in PT) so the offset is for
// the right day. Graph treats calendarView bounds as UTC UNLESS they carry an
// offset, so we must attach this — the Prefer header only affects the response.
function tzOffset(dateStr) {
  const at = new Date(`${dateStr}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: FAMILY_TZ, timeZoneName: "longOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value || "GMT+00:00";
  return name.replace("GMT", "") || "+00:00"; // "-07:00"
}

// Local [start-of-today, +days] as ISO datetimes WITH the family-tz offset, so
// Graph anchors the window to real Pacific midnight (not UTC midnight). Uses a
// UTC-noon anchor for the day math so DST never shifts the date. Pure/exported.
export function familyDateWindow(days = 7, now = new Date()) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: FAMILY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now); // YYYY-MM-DD in family tz
  const [y, m, d] = today.split("-").map(Number);
  const endAnchor = new Date(Date.UTC(y, m - 1, d, 12));
  endAnchor.setUTCDate(endAnchor.getUTCDate() + days);
  const endDate = endAnchor.toISOString().slice(0, 10);
  return {
    startDateTime: `${today}T00:00:00${tzOffset(today)}`,
    endDateTime: `${endDate}T00:00:00${tzOffset(endDate)}`,
  };
}

// Calendars to ignore for scheduling (all-day "free" noise). A shared WORK
// calendar (e.g. "Nic Work", free/busy only) is NOT excluded, so its
// busy/tentative blocks count. Override with GRAPH_CALENDAR_EXCLUDE.
const CALENDAR_EXCLUDE = (process.env.GRAPH_CALENDAR_EXCLUDE || "holiday,birthday")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Cache each mailbox's calendar list (ids are stable; cleared on restart).
const _calendarsCache = new Map();
async function calendarsFor(mailbox) {
  if (_calendarsCache.has(mailbox)) return _calendarsCache.get(mailbox);
  const res = await graph().api(`/users/${mailbox}/calendars`).select("id,name").top(50).get();
  const cals = (res.value || []).filter(
    (cal) => !CALENDAR_EXCLUDE.some((tok) => String(cal.name || "").toLowerCase().includes(tok))
  );
  _calendarsCache.set(mailbox, cals);
  return cals;
}

// Read ALL of a mailbox's calendars (default + secondaries like a shared "Nic
// Work" free/busy calendar) in the window via calendarView (expands recurrences).
// Without this Lloyd saw only the default calendar and missed work busy/tentative.
async function calendarViewFor(mailbox, window) {
  const cals = await calendarsFor(mailbox);
  const owner = calendarOwner(mailbox);
  const per = await Promise.allSettled(
    cals.map((cal) =>
      graph()
        .api(`/users/${mailbox}/calendars/${cal.id}/calendarView`)
        .query({ startDateTime: window.startDateTime, endDateTime: window.endDateTime })
        .header("Prefer", `outlook.timezone="${FAMILY_TZ}"`)
        .select("subject,start,end,location,showAs,attendees")
        .top(50)
        .orderby("start/dateTime")
        .get()
    )
  );
  const events = [];
  for (const r of per) {
    if (r.status !== "fulfilled") continue;
    for (const e of r.value.value || []) {
      // Drop pure free/busy "Free" markers (a shared work calendar emits a "Free"
      // block per open slot). They carry no scheduling value and would bury real
      // events; busy/tentative blockers and real free events (House Cleaning) stay.
      if (e.showAs === "free" && /^(free|available)$/i.test(String(e.subject || "").trim())) continue;
      events.push({
        subject: e.subject,
        day: localDayLabel(e.start?.dateTime), // authoritative weekday; model must not recompute
        start: e.start?.dateTime,
        end: e.end?.dateTime,
        location: e.location?.displayName,
        showAs: e.showAs,
        attendees: (e.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean),
        calendars: [owner],
      });
    }
  }
  return events;
}

// Short owner label (local-part) so the digest can say whose calendar it is.
function calendarOwner(mailbox) {
  return String(mailbox).split("@")[0];
}

/**
 * Merge the family calendars (GRAPH.calendars) over [today, +days], sorted by
 * start. An event invited to both calendars is deduped (subject+start), keeping
 * the union of owners in `calendars`. One mailbox erroring does not sink the
 * rest. `top` caps the merged result.
 */
export async function listEvents({ top, days = GRAPH.calendarDays } = {}) {
  const win = Math.min(Math.max(1, Math.round(days || GRAPH.calendarDays)), 120); // clamp 1..120 days
  // Scale the cap with the window so a longer look-ahead isn't silently truncated
  // (work free/busy adds several blocks/day). Caller can still override `top`.
  const cap = top ?? Math.min(300, Math.max(50, win * 8));
  const window = familyDateWindow(win);
  const per = await Promise.allSettled(GRAPH.calendars.map((mb) => calendarViewFor(mb, window)));
  const byKey = new Map();
  for (const r of per) {
    if (r.status !== "fulfilled") continue;
    for (const e of r.value) {
      const key = `${e.subject}|${e.start}`;
      const existing = byKey.get(key);
      if (existing) existing.calendars = [...new Set([...existing.calendars, ...e.calendars])];
      else byKey.set(key, e);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => String(a.start).localeCompare(String(b.start)))
    .slice(0, cap);
}

/** Create an event on the family calendar (sends invites). High-stakes: confirm upstream. */
export async function createEvent(input) {
  const res = await graph().api(`/users/${GRAPH.calendarWrite}/events`).post(buildEventPayload(input));
  return { id: res.id, webLink: res.webLink, subject: res.subject };
}

/** "Re:"-prefix a subject without doubling it. */
export function reSubject(subject) {
  const s = String(subject || "").trim();
  if (!s) return "Re: your note";
  return /^re:\s/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Reply to an existing message by sending a CLEAN, standalone email to its
 * sender (Mail.Read to look up sender+subject, Mail.Send to send).
 *
 * We deliberately do NOT use Graph's /reply action: it prepends our text into the
 * ORIGINAL message's body, and a realtor/marketing email's HTML (tables, inline
 * CSS, positioned elements) rendered our reply overlaid and unreadable. A fresh
 * message with our text as the whole body cannot be overlaid. Threading is by
 * "Re:" subject (clients still group it); we trade In-Reply-To headers for a
 * reply that is always legible. Falls back to a plain send if lookup fails.
 */
export async function replyToMessage(messageId, text) {
  let to;
  let subject = "your note";
  try {
    const orig = await graph()
      .api(`/users/${GRAPH.mailbox}/messages/${messageId}`)
      .select("subject,from,sender,replyTo")
      .get();
    subject = orig.subject || subject;
    to =
      orig.replyTo?.[0]?.emailAddress?.address ||
      orig.from?.emailAddress?.address ||
      orig.sender?.emailAddress?.address;
  } catch (err) {
    throw new Error(`could not load message ${messageId} to reply: ${err.message}`);
  }
  if (!to) throw new Error(`no reply address on message ${messageId}`);
  const signed = `${String(text).trimEnd()}\n\n${GRAPH.signature}`;
  await sendMail({ to, subject: reSubject(subject), body: signed });
}

/**
 * Send mail from the assistant mailbox. High-stakes: callers (the send_email
 * tool) confirm with the owner first, which covers work-domain sends under the
 * 2026-06-20 policy (no hard block; confirmation is the gate).
 */
export async function sendMail({ to, subject, body, html = false }) {
  // Accept an array OR a comma/semicolon-separated string. Lloyd often passes
  // "a@x.com, b@y.com" as one string; without splitting, Graph treats the whole
  // string as a single recipient and rejects it ("recipient not resolved").
  const recipients = (Array.isArray(to) ? to : String(to ?? "").split(/[,;]/))
    .map((a) => a.trim())
    .filter(Boolean);
  if (!recipients.length) throw new Error("sendMail: no valid recipient");
  await graph()
    .api(`/users/${GRAPH.mailbox}/sendMail`)
    .post({
      message: {
        subject,
        body: { contentType: html ? "HTML" : "Text", content: body },
        toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    });
}

// --- Clickable email approvals (Approve/Deny buttons) -----------------------
// The daemon is not publicly reachable, so a one-click HTTP link would need a
// public endpoint (and would risk email link-scanners auto-approving). Instead
// the buttons are mailto: links that pre-compose the "YES <code>" / "NO <code>"
// reply to the assistant mailbox. Tapping opens the composer; sending routes
// through the SAME authenticated inbound-mail path a typed reply uses, so no new
// public surface and no scanner can trigger it (a scanner won't hit "send").

const _glog = createLogger("graph");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Build the HTML approval email (Approve/Deny mailto buttons). Pure/exported. */
export function approvalEmailHtml(code, action, mailbox = GRAPH.mailbox) {
  const mailto = (decision, word) =>
    `mailto:${encodeURIComponent(mailbox)}?subject=${encodeURIComponent(`${decision} ${code}`)}&body=${encodeURIComponent(`${word} ${code}`)}`;
  const btn = (href, label, color) =>
    `<a href="${href}" style="display:inline-block;padding:10px 22px;margin:4px 8px 4px 0;border-radius:6px;background:${color};color:#fff;text-decoration:none;font-weight:600;font-family:-apple-system,Segoe UI,Arial,sans-serif">${label}</a>`;
  return [
    `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;color:#222">`,
    `<p>Approval needed:</p>`,
    `<pre style="background:#f5f5f7;padding:12px;border-radius:6px;white-space:pre-wrap;font-family:inherit">${esc(action)}</pre>`,
    `<p>${btn(mailto("Approve", "YES"), "Approve", "#2e7d32")}${btn(mailto("Deny", "NO"), "Deny", "#c62828")}</p>`,
    `<p style="color:#666;font-size:13px">Tapping a button opens a pre-filled reply; just hit send. Or reply to this email with "YES ${esc(code)}" or "NO ${esc(code)}".</p>`,
    `</div>`,
  ].join("");
}

/** Register email as an approval channel: each staged action emails Approve/Deny
 *  buttons to GRAPH.approvalEmailTo. No-op if no recipient is configured. */
export function registerEmailApprovals() {
  if (!GRAPH.approvalEmailTo.length) return;
  registerApprovalNotifier(({ code, action }) => {
    sendMail({
      to: GRAPH.approvalEmailTo,
      subject: `Approval needed (${code})`,
      body: approvalEmailHtml(code, action),
      html: true,
    }).catch((e) => _glog.error("approval email failed", { reason: e.message, code }));
  });
}
