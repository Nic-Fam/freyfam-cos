import { agentLoop, systemBlocks } from "./claude.js";
import { modelForComplexity } from "./config.js";
import { triageInbound } from "./triage.js";
import { recall, remember } from "./memory.js";
import { logDecision, listDecisions } from "./decisions.js";
import { requestConfirmation, tryResolveConfirmation } from "./confirm.js";
import { sendSms } from "./channels/twilio.js";
import { recentMailSignals, sendMail, fetchAttachments, listEvents, createEvent, replyToMessage } from "./channels/graph.js";
import { persona } from "./persona.js";
import { delegate } from "./delegate.js";
import { readPage, runOrder } from "./channels/browser.js";
import { fetchInboundMedia } from "./media.js";
import { extractDocuments } from "./documents.js";
import { getHouseRules, formatHouseRules } from "./rules.js";
import { getFoxToday, setFoxDay } from "./fox.js";
import { isWorkDomain, shouldAutoReply } from "./guards.js";
import { createLogger } from "./log.js";

const log = createLogger("orchestrator");

// --- Tools available to the chief of staff -------------------------------
// Sub-agents are exposed as delegate tools: the chief decides scope, the
// specialist does the work with its own persona. High-stakes effects are
// always wrapped in a confirmation request.

const tools = [
  {
    name: "recall_memory",
    description: "Search the family's long-term memory (preferences, facts, history).",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "remember",
    description: "Save a durable fact or preference to the family's memory.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "log_decision",
    description: "Record a final decision you reached, with a short why, to your durable decision log. Does not take any real-world action.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        decision: { type: "string" },
        rationale: { type: "string" },
        context: { type: "string" },
      },
      required: ["title", "decision"],
    },
  },
  {
    name: "list_decisions",
    description: "List recent recorded decisions, newest first. Omit 'agent' for your own; pass a specialist key (finance, dev, resale, chef, security) to review what they decided.",
    input_schema: {
      type: "object",
      properties: { agent: { type: "string", enum: ["chief-of-staff", "finance", "dev", "resale", "chef", "security"] } },
    },
  },
  {
    name: "delegate",
    description: "Hand a scoped task to a specialist agent and get their result. Use 'chef' for meal planning and kitchen inventory, 'security' for home + IT security.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["finance", "dev", "resale", "chef", "security"] },
        task: { type: "string" },
      },
      required: ["agent", "task"],
    },
  },
  {
    name: "list_calendar",
    description: "List upcoming events on the family calendar (read-only).",
    input_schema: { type: "object", properties: { top: { type: "number" } } },
  },
  {
    name: "fox_today",
    description:
      "Get Fox's Bright Horizons day: activities, theme, and a wardrobe hint (e.g. old clothes on paint days, a change of clothes on water days). Read-only.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; defaults to today" } } },
  },
  {
    name: "set_fox_day",
    description:
      "Save Fox's Bright Horizons activities for a day. Call this when a Bright Horizons email arrives (one call per day it covers). A wardrobe hint is derived automatically from the activities (paint/messy -> old clothes; water -> a full change + towel). Operates only on the family's own data; no outbound.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        activities: { type: "string", description: "the day's activities / lesson plan" },
        themeOrUnit: { type: "string", description: "weekly curriculum theme, if given" },
        clothingHint: { type: "string", description: "optional; auto-derived from activities if omitted" },
      },
      required: ["date", "activities"],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Create a calendar event and invite attendees. High-stakes (sends invites): requires owner approval. Apply the house rules above — e.g. for workday appointments include Nic's and Shelli's work emails as attendees; mark House Cleaning events showAs='free'. Times are ISO strings in the family's timezone.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        start: { type: "string", description: "ISO start, e.g. 2026-06-25T14:00:00" },
        end: { type: "string", description: "ISO end; defaults to start if omitted" },
        attendees: { type: "array", items: { type: "string" }, description: "invitee email addresses" },
        location: { type: "string" },
        showAs: { type: "string", enum: ["free", "busy"] },
        body: { type: "string" },
      },
      required: ["subject", "start"],
    },
  },
  {
    name: "send_email",
    description: "Send an email from the assistant mailbox. High-stakes: requires owner approval.",
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "browse_page",
    description:
      "Read a public web page in the local headless browser and get back its title and visible text. Read-only: it never clicks, fills, or buys. Use it to check listings, prices, or availability.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" }, maxChars: { type: "number" } },
      required: ["url"],
    },
  },
  {
    name: "place_order",
    description:
      "Drive a checkout or purchase flow in the local headless browser. High-stakes: it spends money, so it always requires owner approval first. Give a clear summary of what is being bought and for how much, plus the ordered browser steps to reach and confirm checkout.",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string" },
        summary: { type: "string", description: "What is being bought and for how much." },
        steps: {
          type: "array",
          description: "Ordered actions: goto/click/fill/waitFor.",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["goto", "click", "fill", "waitFor"] },
              url: { type: "string" },
              selector: { type: "string" },
              value: { type: "string" },
            },
            required: ["action"],
          },
        },
      },
      required: ["url", "summary"],
    },
  },
];

// --- Transports: how one turn delivers its result + mirrors its work --------
// A transport is { reply(text), mirror(event) }. SMS and email are built in;
// SMS/email have no observability channel so their mirror is a no-op. Slack
// (src/channels/slack.js) provides its own transport (reply -> the channel,
// mirror -> #command) and passes it to handleInbound. Internal callers (the
// heartbeat) use runChief directly and need no transport.
const noop = () => {};

// Keep the inbound subject so an email reply threads (continuity). Avoids "Re: Re:";
// falls back when the front door didn't pass a subject. SMS has no subject.
export function replySubject(subject) {
  const s = String(subject || "").trim();
  if (!s) return "Re: your note";
  return /^re:\s/i.test(s) ? s : `Re: ${s}`;
}

// deps injectable for tests; default to the real channel functions.
export function transportFor(msg, { onSms = sendSms, onMail = sendMail, onReply = replyToMessage } = {}) {
  if (msg.channel === "sms") {
    return { reply: (text) => onSms(msg.replyTo || msg.from, text), mirror: noop };
  }
  if (msg.channel === "email") {
    return {
      // Thread in-place when we have the original message id (header-level
      // continuity); otherwise send fresh, retaining the subject line.
      reply: (text) =>
        msg.graphMessageId
          ? onReply(msg.graphMessageId, text)
          : onMail({ to: msg.replyTo || msg.from, subject: replySubject(msg.subject), body: text }),
      mirror: noop,
    };
  }
  return { reply: noop, mirror: noop };
}

/**
 * Wrap the delegate call so each delegation is echoed to `onDelegate` (which a
 * transport routes to its observability channel, e.g. Slack #command): one event
 * when Lloyd hands off, one with the specialist's result. This is the whole
 * "watch Lloyd run the team" feature, and it works whether the specialist runs
 * in-process or remote because `delegate` already abstracts transport. Exported
 * pure for testing. `images` rides along (MMS photos) so the specialist sees them.
 */
export function wrapDelegateWithMirror(delegateFn, { onDelegate, images } = {}) {
  return async ({ agent, task }) => {
    await onDelegate?.({ phase: "start", from: "Lloyd", agent, task });
    const result = await delegateFn({ agent, task, images });
    await onDelegate?.({ phase: "result", from: "Lloyd", agent, task, result });
    return result;
  };
}

function toolHandlers({ images, onDelegate } = {}) {
  return {
    recall_memory: async ({ query }) => JSON.stringify(await recall(query)),
    remember: async ({ text }) => {
      await remember(text);
      return "saved";
    },
    log_decision: async (input) => JSON.stringify(await logDecision("chief-of-staff", input)),
    list_decisions: async ({ agent } = {}) => JSON.stringify(await listDecisions(agent || "chief-of-staff")),
    // The schema stays {agent, task}; `images` come from context, not the model.
    // The wrapper also mirrors the handoff + result to the transport's observability.
    delegate: wrapDelegateWithMirror(delegate, { onDelegate, images }),
    list_calendar: async ({ top } = {}) => JSON.stringify(await listEvents({ top })),
    fox_today: async ({ date } = {}) =>
      JSON.stringify((await getFoxToday(date)) || { note: "no Bright Horizons context captured for that day yet" }),
    set_fox_day: async ({ date, activities, themeOrUnit, clothingHint }) => {
      const row = await setFoxDay(date, { activities, themeOrUnit, clothingHint });
      return `Saved Fox's day ${date}. Wardrobe: ${row.clothingHint || "(none derived)"}`;
    },
    create_calendar_event: async (input) => {
      const who = (input.attendees || []).join(", ") || "(no invitees)";
      const when = `${input.start}${input.end ? ` – ${input.end}` : ""}`;
      const ok = await requestConfirmation(
        `Create event: ${input.subject}\n${when}\nInvitees: ${who}${input.showAs ? `\nShow as: ${input.showAs}` : ""}`
      );
      if (!ok) return "Owner declined; no event created.";
      try {
        const r = await createEvent(input);
        return `Event created: ${r.subject}${r.webLink ? ` (${r.webLink})` : ""}`;
      } catch (e) {
        return `Could not create event: ${e.message}`;
      }
    },
    send_email: async ({ to, subject, body }) => {
      const flag = isWorkDomain(to) ? " [WORK DOMAIN]" : "";
      const ok = await requestConfirmation(`Email to ${to}${flag}\nSubject: ${subject}\n${body.slice(0, 200)}`);
      if (!ok) return "Owner declined; email not sent.";
      await sendMail({ to, subject, body }); // confirmation above is the gate (work domains flagged)
      return "Email sent.";
    },
    browse_page: async ({ url, maxChars }) => {
      try {
        return JSON.stringify(await readPage(url, { maxChars }));
      } catch (e) {
        return `Could not read page: ${e.message}`;
      }
    },
    place_order: async ({ url, summary, steps }) => {
      const ok = await requestConfirmation(`Place order via browser:\n${summary}\n${url}`);
      if (!ok) return "Owner declined; no order placed.";
      try {
        const r = await runOrder({ url, steps }); // guard inside blocks read-only domains
        return `Order flow ran. Final URL: ${r.finalUrl}\nSteps: ${r.transcript.join(", ")}`;
      } catch (e) {
        return `Order flow failed: ${e.message}`;
      }
    },
  };
}

/**
 * Main entry for an inbound family message. Triage first (cheap), then route to
 * the right agent at the right model tier, then reply over the same channel.
 * @param {{from:string, body:string, channel:"sms"|"email", replyTo?:string}} msg
 */
/**
 * Run the chief-of-staff agent loop on a piece of work and return its text.
 * Pure compute: it does NOT send anything. Callers decide delivery (reply on the
 * inbound channel, or notify the owner). Shared by inbound handling and the
 * proactive heartbeat, so the heartbeat no longer fakes an inbound SMS to itself.
 */
// Family-local clock. `toISOString()` emits UTC, which made Lloyd think it was
// ~1:30am when it was early evening Pacific; the house rules ("during the
// workday") also need local time. Render an unambiguous local string + the zone.
const FAMILY_TZ = process.env.FAMILY_TZ || "America/Los_Angeles";
export function nowInFamilyTz(now = new Date()) {
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: FAMILY_TZ,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
  return `${local} (${FAMILY_TZ})`;
}

export async function runChief(body, model, { content, images, onDelegate } = {}) {
  const p = await persona("chief-of-staff");
  const mems = await recall(body, 4); // recall always keys off the text
  const rules = await getHouseRules(); // ALWAYS injected, not subject to recall
  const volatile = [
    `Now: ${nowInFamilyTz()}`,
    formatHouseRules(rules),
    mems.length ? `Relevant memory:\n${mems.map((m) => "- " + m.text).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const { text } = await agentLoop({
    model,
    system: systemBlocks(p, volatile),
    // `content` (text + image blocks) wins when an MMS carried photos; else plain text.
    messages: [{ role: "user", content: content || body }],
    tools,
    toolHandlers: toolHandlers({ images, onDelegate }), // images + delegation mirror
  });
  return text;
}

// Materialize email attachments: inline {bytes|contentBytes} from the front door,
// or fetched from the mailbox via Graph when a graphMessageId is present. Non-fatal.
async function collectAttachments(msg) {
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    return msg.attachments
      .map((a) => ({
        name: a.name,
        contentType: a.contentType,
        bytes: a.bytes ?? (a.contentBytes ? Buffer.from(a.contentBytes, "base64") : undefined),
      }))
      .filter((a) => a.bytes);
  }
  if (msg.graphMessageId) {
    try {
      return await fetchAttachments(msg.graphMessageId);
    } catch {
      return []; // an attachment-fetch failure must not drop the message
    }
  }
  return [];
}

/**
 * Main entry for an inbound family message. Triage first (cheap), route to the
 * chief at the right tier, then deliver via the transport (reply on the inbound
 * channel; mirror delegations to its observability channel if it has one).
 * @param {{from:string, body:string, channel:string, replyTo?:string, media?:object[], subject?:string, graphMessageId?:string}} msg
 * @param {{reply:Function, mirror:Function}} [transport] defaults to the channel's built-in
 */
export async function handleInbound(msg, transport = transportFor(msg)) {
  // 0. Is this a YES/NO answer to a pending approval? If so, it's already handled.
  if (tryResolveConfirmation(msg.body)) return;

  // 0b. Never auto-reply to machine senders (bounces, no-reply, marketing) or to
  //     our own mailbox. The email front door enqueues everything in the mailbox,
  //     so this is the chokepoint that stops bounce loops and saves tokens. SMS /
  //     Slack senders never match, so they always pass.
  if (!shouldAutoReply(msg.from)) {
    log.info("auto-reply suppressed (automated/self sender)", { from: msg.from, channel: msg.channel });
    return;
  }

  // 1. Gather non-text content (all non-fatal): MMS photos -> Claude image blocks
  //    (vision); email attachments -> document text blocks (PDF/.ics/.vcf). Lloyd
  //    is multimodal here: read a receipt photo or a PDF invoice, then delegate to
  //    Carmine (groceries) / Shey (resale) / Patrick (finance).
  const extraBlocks = [];
  const triageNotes = [];
  let images;

  if (Array.isArray(msg.media) && msg.media.length) {
    const { imageBlocks } = await fetchInboundMedia(msg.media);
    if (imageBlocks.length) {
      images = imageBlocks; // forwarded to specialists on delegate
      extraBlocks.push(...imageBlocks);
      triageNotes.push(`${imageBlocks.length} photo(s)`);
    }
  }

  const attachments = await collectAttachments(msg);
  if (attachments.length) {
    const { blocks, summaries } = await extractDocuments(attachments);
    extraBlocks.push(...blocks);
    triageNotes.push(...summaries);
  }

  let content;
  let triageText = msg.body || "";
  if (extraBlocks.length) {
    content = [{ type: "text", text: msg.body?.trim() || "(attachment, no message)" }, ...extraBlocks];
    triageText = [msg.body || "", `[${triageNotes.join("; ")}]`].filter((s) => s.trim()).join("\n").trim();
  }

  // 2. Cheap classification -> pick the cheapest sufficient model.
  const t = await triageInbound(triageText);
  const model = modelForComplexity(t.complexity, t.high_stakes);

  // 3. Run the chief of staff (or answer trivially on Haiku). recall keys off the
  //    text; `content` carries the images to Lloyd, `images` forwards them to any
  //    specialist he delegates to this turn; `onDelegate` mirrors each handoff to
  //    the transport's observability channel (no-op for SMS/email).
  const text = await runChief(msg.body || "(photo message)", model, {
    content,
    images,
    onDelegate: (event) => transport.mirror(event),
  });

  // 4. Deliver via the transport (channel reply for SMS/email; channel post for Slack).
  await transport.reply(text);
  return text;
}

// Re-export for the heartbeat to escalate actionable items into real runs.
export { recentMailSignals };
