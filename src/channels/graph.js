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
// Events live on the cos@ mailbox calendar; family + (per house rules) work
// addresses are invited. Needs Graph `Calendars.ReadWrite` application permission
// + admin consent (NOT yet granted — Mail.Read/Send are). Creating an event sends
// invites, so it's high-stakes: the create_calendar_event tool confirms first.

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

/** Upcoming events on the cos@ calendar (read-only). */
export async function listEvents({ top = 20 } = {}) {
  const res = await graph()
    .api(`/users/${GRAPH.mailbox}/events`)
    .select("subject,start,end,location,showAs,attendees")
    .top(top)
    .orderby("start/dateTime")
    .get();
  return (res.value || []).map((e) => ({
    subject: e.subject,
    start: e.start?.dateTime,
    end: e.end?.dateTime,
    location: e.location?.displayName,
    showAs: e.showAs,
    attendees: (e.attendees || []).map((a) => a.emailAddress?.address).filter(Boolean),
  }));
}

/** Create an event (sends invites to attendees). High-stakes: confirm upstream. */
export async function createEvent(input) {
  const res = await graph().api(`/users/${GRAPH.mailbox}/events`).post(buildEventPayload(input));
  return { id: res.id, webLink: res.webLink, subject: res.subject };
}

/**
 * Reply to an existing message IN-THREAD. Graph's reply action preserves the
 * conversation + sets In-Reply-To/References, so the reply collapses into the same
 * email thread in the client (true continuity, beyond a matching subject line).
 * Replies to the original sender. Needs the front door to pass `graphMessageId`
 * and to NOT delete the message. Uses Mail.Send/Read (already granted — no new
 * consent). Falls back to sendMail when no messageId is available.
 */
export async function replyToMessage(messageId, text) {
  await graph()
    .api(`/users/${GRAPH.mailbox}/messages/${messageId}/reply`)
    .post({ comment: String(text ?? "") });
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
