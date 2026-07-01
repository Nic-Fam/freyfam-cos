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
 * Recent inbox messages WITH bodies, for the proactive shipment scan (the
 * heartbeat reads tracking numbers, which live in the body, not the headers).
 * Distinct from recentMailSignals (headers only) because pulling bodies is
 * heavier, so callers run it on a slow cadence. Returns {from, subject, body}.
 */
export async function recentShipmentMail({ top = 25 } = {}) {
  const res = await graph()
    .api(`/users/${GRAPH.mailbox}/mailFolders/inbox/messages`)
    .top(top)
    .select("from,subject,body,receivedDateTime")
    .orderby("receivedDateTime desc")
    .get();
  return (res.value || []).map((m) => ({
    from: m.from?.emailAddress?.address,
    subject: m.subject || "",
    body: m.body?.content || "",
    receivedAt: m.receivedDateTime,
  }));
}

/**
 * Recent inbox messages WITH the Graph id and a plain-text preview, for the
 * daemon-side inbound EMAIL reconcile (src/email-reconcile.js). The reconcile
 * needs the id (dedup key + reply threading) and a clean body the chief can
 * read, so this returns {id, from, subject, body, receivedAt, unread} using
 * bodyPreview (plain text) rather than raw HTML.
 */
export async function recentInboxFull({ top = 25 } = {}) {
  const res = await graph()
    .api(`/users/${GRAPH.mailbox}/mailFolders/inbox/messages`)
    .top(top)
    .select("id,from,subject,bodyPreview,receivedDateTime,isRead")
    .orderby("receivedDateTime desc")
    .get();
  return (res.value || []).map((m) => ({
    id: m.id,
    from: m.from?.emailAddress?.address,
    subject: m.subject || "",
    body: (m.bodyPreview || "").replace(/\s*Sent from my iPhone\s*$/i, "").trim(),
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

// M365 To Do shopping lists. The Alexa "Frey" skill (and/or a native-list → IFTTT
// bridge) writes items the family adds at the fridge into named To Do lists
// ("Ralphs" / "Costco" / "Amazon Shopping List") under TODO_USER. Lloyd/Chef read
// them here so Alexa-added items flow into the grocery order. App-only Graph, same
// app the front door already uses for To Do (Tasks application permission).
const TODO_USER = () => process.env.GRAPH_TODO_USER || "nic@freyfam.com";

async function todoListId(listName, user) {
  const lists = await graph().api(`/users/${user}/todo/lists`).get();
  const l = (lists.value || []).find((x) => String(x.displayName).toLowerCase() === String(listName).toLowerCase());
  return l ? l.id : null;
}

/** Open (non-completed) items in a named To Do list. Returns [{id, title, listId}]. */
export async function listTodoTasks(listName, { user = TODO_USER() } = {}) {
  const listId = await todoListId(listName, user);
  if (!listId) return [];
  const res = await graph().api(`/users/${user}/todo/lists/${listId}/tasks`).top(100).get();
  return (res.value || [])
    .filter((t) => t.status !== "completed")
    .map((t) => ({ id: t.id, title: t.title, listId }));
}

/** Mark a To Do task completed (used to clear items once they're ordered). */
export async function completeTodoTask(listId, taskId, { user = TODO_USER() } = {}) {
  await graph().api(`/users/${user}/todo/lists/${listId}/tasks/${taskId}`).patch({ status: "completed" });
}

/**
 * Add an item to a named To Do list (the same lists the Alexa skills write to), so
 * Lloyd can add to the Ralphs/Costco/Amazon list from any channel — the reliable
 * backup to Alexa (Option B). Creates the list if it's missing. Returns {id,title,listId}.
 */
export async function addTodoTask(listName, title, { user = TODO_USER() } = {}) {
  const item = String(title || "").trim();
  if (!item) throw new Error("item is required");
  let listId = await todoListId(listName, user);
  if (!listId) {
    const created = await graph().api(`/users/${user}/todo/lists`).post({ displayName: listName });
    listId = created.id;
  }
  const task = await graph().api(`/users/${user}/todo/lists/${listId}/tasks`).post({ title: item });
  return { id: task.id, title: task.title, listId };
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
export function familyDateWindow(days = 7, now = new Date(), { back = 0 } = {}) {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: FAMILY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now); // YYYY-MM-DD in family tz
  const [y, m, d] = today.split("-").map(Number);
  // start = today minus `back` days (back=0 keeps the old behavior: start today).
  const startAnchor = new Date(Date.UTC(y, m - 1, d, 12));
  startAnchor.setUTCDate(startAnchor.getUTCDate() - Math.max(0, Math.round(back)));
  const startDate = startAnchor.toISOString().slice(0, 10);
  const endAnchor = new Date(Date.UTC(y, m - 1, d, 12));
  endAnchor.setUTCDate(endAnchor.getUTCDate() + days);
  const endDate = endAnchor.toISOString().slice(0, 10);
  return {
    startDateTime: `${startDate}T00:00:00${tzOffset(startDate)}`,
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
        .select("id,subject,start,end,location,showAs,attendees")
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
        // Stable handle(s) for delete_calendar_event: which mailbox + Graph event id.
        // An event invited to both calendars dedups below into one entry with both refs.
        refs: e.id ? [{ calendar: mailbox, id: e.id }] : [],
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
export async function listEvents({ top, days = GRAPH.calendarDays, back = 0 } = {}) {
  const win = Math.min(Math.max(1, Math.round(days || GRAPH.calendarDays)), 120); // clamp 1..120 days
  const lookBack = Math.min(Math.max(0, Math.round(back)), 14); // 0..14 days of look-back (digest follow-ups)
  // Scale the cap with the window so a longer look-ahead isn't silently truncated
  // (work free/busy adds several blocks/day). Caller can still override `top`.
  const cap = top ?? Math.min(300, Math.max(50, (win + lookBack) * 8));
  const window = familyDateWindow(win, new Date(), { back: lookBack });
  const per = await Promise.allSettled(GRAPH.calendars.map((mb) => calendarViewFor(mb, window)));
  const byKey = new Map();
  for (const r of per) {
    if (r.status !== "fulfilled") continue;
    for (const e of r.value) {
      const key = `${e.subject}|${e.start}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.calendars = [...new Set([...existing.calendars, ...e.calendars])];
        const seen = new Set(existing.refs.map((r) => r.id));
        existing.refs = [...existing.refs, ...e.refs.filter((r) => !seen.has(r.id))];
      } else byKey.set(key, e);
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

/**
 * Delete (cancel) events from the family calendars. Takes the `refs` array a
 * list_calendar event carries ([{calendar, id}], one per calendar it's on), so a
 * single event invited to both calendars is removed from both. Irreversible and
 * notifies attendees: confirm upstream. Returns {deleted, errors}.
 */
export async function deleteEvent({ refs } = {}) {
  const list = (Array.isArray(refs) ? refs : []).filter((r) => r && r.calendar && r.id);
  if (!list.length) throw new Error("deleteEvent requires refs: [{ calendar, id }]");
  const deleted = [];
  const errors = [];
  for (const r of list) {
    try {
      await graph().api(`/users/${r.calendar}/events/${r.id}`).delete();
      deleted.push(r);
    } catch (err) {
      errors.push({ ref: r, reason: err.message });
    }
  }
  return { deleted, errors };
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
// Build the Graph `message` object. Pure + exported so the recipient logic (the
// comma-split + cc/bcc handling that the "loop Nic in" fix depends on) is unit-
// testable without a network call. Accepts an array OR a comma/semicolon string
// per field: Lloyd often passes "a@x.com, b@y.com" as one string, and without
// splitting Graph treats the whole string as one recipient and rejects it.
export function buildMailMessage({ to, subject, body, cc, bcc, html = false }) {
  const addrs = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/[,;]/)).map((a) => a.trim()).filter(Boolean);
  const box = (list) => list.map((address) => ({ emailAddress: { address } }));
  const recipients = addrs(to);
  if (!recipients.length) throw new Error("sendMail: no valid recipient");
  const message = {
    subject,
    body: { contentType: html ? "HTML" : "Text", content: body },
    toRecipients: box(recipients),
  };
  const ccList = addrs(cc);
  const bccList = addrs(bcc);
  if (ccList.length) message.ccRecipients = box(ccList);
  if (bccList.length) message.bccRecipients = box(bccList);
  return message;
}

export async function sendMail({ to, subject, body, cc, bcc, html = false }) {
  const message = buildMailMessage({ to, subject, body, cc, bcc, html });
  await graph()
    .api(`/users/${GRAPH.mailbox}/sendMail`)
    .post({ message, saveToSentItems: true });
}

/**
 * Send a mail with a single file attachment (e.g. the budget-burn PNG chart).
 * `attachment` = { bytes:Buffer, filename, contentType }.
 */
export async function sendMailWithAttachment({ to, subject, body = "", attachment, cc, bcc, html = false } = {}) {
  const message = buildMailMessage({ to, subject, body, cc, bcc, html });
  message.attachments = [{
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: attachment?.filename || "attachment.bin",
    contentType: attachment?.contentType || "application/octet-stream",
    contentBytes: Buffer.isBuffer(attachment?.bytes) ? attachment.bytes.toString("base64") : String(attachment?.bytes || ""),
  }];
  await graph().api(`/users/${GRAPH.mailbox}/sendMail`).post({ message, saveToSentItems: true });
}

/**
 * Send a mail with an audio (or file) attachment — Lloyd's audible voice reply over
 * email. `audio` = { bytes:Buffer, filename, contentType }.
 */
export async function sendVoiceMail({ to, subject, audio, body = "", cc, bcc } = {}) {
  const message = buildMailMessage({ to, subject, body: body || "(voice reply attached)", cc, bcc });
  message.attachments = [{
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: audio?.filename || "lloyd.mp3",
    contentType: audio?.contentType || "audio/mpeg",
    contentBytes: Buffer.isBuffer(audio?.bytes) ? audio.bytes.toString("base64") : String(audio?.bytes || ""),
  }];
  await graph()
    .api(`/users/${GRAPH.mailbox}/sendMail`)
    .post({ message, saveToSentItems: true });
}

// Resolve which family mailbox a draft is saved into. Default Nic. Accepts a
// person key ("nic"/"shelli") or a full address. Pure + exported for tests.
const DRAFT_MAILBOXES = {
  nic: process.env.NIC_MAILBOX || "nic@freyfam.com",
  shelli: process.env.SHELLI_MAILBOX || "shelli@freyfam.com",
};
export function draftMailboxFor(account) {
  const key = String(account || "nic").trim().toLowerCase();
  if (DRAFT_MAILBOXES[key]) return DRAFT_MAILBOXES[key];
  return key.includes("@") ? key : DRAFT_MAILBOXES.nic;
}

/**
 * Save an email as a DRAFT in a family member's OWN mailbox (default Nic). Lloyd
 * writes on the family's behalf; the draft lands in that person's Drafts folder
 * and is NEVER sent (POST /users/{mailbox}/messages creates an unsent draft,
 * isDraft=true). The human opens it in their mail app, edits if needed, and sends
 * it themselves. This is the SAFE alternative to sendMail: no outbound leaves the
 * system, so it needs no confirmation gate. Returns {id, webLink, mailbox}.
 */
export async function createDraft({ account = "nic", to, subject, body, cc, bcc, html = false }) {
  const mailbox = draftMailboxFor(account);
  const message = buildMailMessage({ to, subject, body, cc, bcc, html });
  const res = await graph().api(`/users/${mailbox}/messages`).post(message);
  return { id: res.id, webLink: res.webLink, mailbox };
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
