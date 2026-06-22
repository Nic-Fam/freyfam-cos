import { ClientSecretCredential } from "@azure/identity";
import { Client } from "@microsoft/microsoft-graph-client";
import { GRAPH } from "../config.js";

const FAMILY_TZ = process.env.FAMILY_TZ || "America/Los_Angeles";

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

// Read one mailbox's events in the window via calendarView (expands recurrences).
async function calendarViewFor(mailbox, window) {
  const res = await graph()
    .api(`/users/${mailbox}/calendarView`)
    .query({ startDateTime: window.startDateTime, endDateTime: window.endDateTime })
    .header("Prefer", `outlook.timezone="${FAMILY_TZ}"`)
    .select("subject,start,end,location,showAs,attendees")
    .top(50)
    .orderby("start/dateTime")
    .get();
  return (res.value || []).map((e) => ({
    subject: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName,
    showAs: e.showAs,
    attendees: (e.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean),
    calendars: [calendarOwner(mailbox)],
  }));
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
export async function listEvents({ top = 20, days = GRAPH.calendarDays } = {}) {
  const window = familyDateWindow(days);
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
    .slice(0, top);
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
export async function sendMail({ to, subject, body }) {
  const recipients = Array.isArray(to) ? to : [to];
  await graph()
    .api(`/users/${GRAPH.mailbox}/sendMail`)
    .post({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    });
}
