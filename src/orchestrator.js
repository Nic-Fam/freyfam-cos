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
import { extractDocuments, fetchDocument } from "./documents.js";
import { getHouseRules, formatHouseRules, getAgentRules, addRule, removeRule, KNOWN_AGENTS } from "./rules.js";
import { getFoxToday, setFoxDay } from "./fox.js";
import { fetchFoxWeek } from "./fox-curriculum.js";
import { getCommuteTime, formatCommute } from "./commute.js";
import { webSearch } from "./search.js";
import { conversationKey, getHistory, appendTurn } from "./conversation.js";
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
    description:
      "Save a durable fact or preference to memory. Omit `agent` for a shared/household fact; set `agent` (finance, dev, resale, chef, security) to seed THAT specialist's brain (e.g. an allergy for chef, a target brand for resale). Use this whenever the family tells you something worth keeping.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, agent: { type: "string", enum: KNOWN_AGENTS.filter((a) => a !== "chief") } },
      required: ["text"],
    },
  },
  {
    name: "add_rule",
    description:
      "Save a STANDING RULE the family wants always applied (not a one-off fact). Omit `agent` for a household rule you (the chief) follow; set `agent` (finance, dev, resale, chef, security) for a rule that specialist must always follow (e.g. chef: 'never plan a meal with nuts for Fox'). Rules apply on the next message, no restart. Use this when the family says 'always', 'never', or 'from now on'.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string" }, agent: { type: "string", enum: KNOWN_AGENTS } },
      required: ["text"],
    },
  },
  {
    name: "list_rules",
    description: "List the current standing rules. Omit `agent` for the household rules; set `agent` to see that specialist's rules. Use it to review before adding or removing.",
    input_schema: { type: "object", properties: { agent: { type: "string", enum: KNOWN_AGENTS } } },
  },
  {
    name: "remove_rule",
    description: "Remove a standing rule by its number (as shown by list_rules) or exact text. Omit `agent` for a household rule; set `agent` for a specialist's rule.",
    input_schema: { type: "object", properties: { match: { type: "string" }, agent: { type: "string", enum: KNOWN_AGENTS } }, required: ["match"] },
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
    description:
      "List upcoming events across the family calendars (Nic's and Shelli's, merged), read-only. Each event has a `calendars` field naming whose calendar it is on. Defaults to the next several days; pass `days: 1` for just today (e.g. the morning digest).",
    input_schema: { type: "object", properties: { top: { type: "number" } } },
  },
  {
    name: "fox_today",
    description:
      "Get Fox's Bright Horizons day: activities, theme, and a wardrobe hint (e.g. old clothes on paint days, a change of clothes on water days). Read-only.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; defaults to today" } } },
  },
  {
    name: "ingest_fox_curriculum",
    description:
      "Fetch a Bright Horizons WEEKLY curriculum PDF link and save Fox's activities PER DAY automatically (one entry per weekday, with a wardrobe hint each). Use this on a Bright Horizons email. Returns what was saved.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "set_fox_day",
    description:
      "Save Fox's Bright Horizons activities for ONE day (fallback / manual correction; prefer ingest_fox_curriculum for a weekly PDF). A wardrobe hint is derived automatically from the activities (paint/messy -> old clothes; water -> a full change + towel). Operates only on the family's own data; no outbound.",
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
    name: "fetch_document",
    description:
      "Fetch a document at a URL and return its text. Handles PDF, .ics (calendar), and .vcf (contact). Read-only. Use for document LINKS in an email body — e.g. a Bright Horizons curriculum PDF link. For Fox's curriculum, then call set_fox_day with the activities.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "search",
    description:
      "Search the web (read-only) and get back ranked results as {title, url, snippet}. Use it to find an address, hours, a fact, or a listing; then read the best hit with browse_page. Acting on a result (email/buy) still routes through the confirmation gate.",
    input_schema: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query"] },
  },
  {
    name: "commute_time",
    description:
      "Precise door-to-door driving time with LIVE traffic between two addresses (Azure Maps). Returns minutes, miles, current delay, and a traffic label. Use this for real commute ETAs (e.g. the morning digest's per-person routes); it is accurate where web search is not. The standing locations are in the house rules.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Start address (usually home)." },
        dest: { type: "string", description: "Destination address." },
      },
      required: ["origin", "dest"],
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
    // Optional `agent` routes the fact to that specialist's scoped brain; omit for shared.
    remember: async ({ text, agent }) => {
      await remember(text, agent ? { agent } : {});
      return agent ? `saved to ${agent}'s memory` : "saved";
    },
    add_rule: async ({ text, agent }) => {
      try {
        const r = await addRule(text, agent ? { agent } : {});
        const where = r.scope === "house" ? "household" : `${r.scope}'s`;
        return r.added ? `Saved a ${where} rule: "${r.text}"` : `That ${where} rule already exists.`;
      } catch (e) {
        return `Could not add rule: ${e.message}`;
      }
    },
    list_rules: async ({ agent } = {}) => {
      const rules = agent ? await getAgentRules(agent) : await getHouseRules();
      const label = agent ? `${agent}'s rules` : "household rules";
      if (!rules.length) return `No ${label} yet.`;
      return `${label}:\n` + rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
    },
    remove_rule: async ({ match, agent }) => {
      try {
        const removed = await removeRule(match, agent ? { agent } : {});
        return removed ? `Removed: "${removed}"` : "No matching rule found.";
      } catch (e) {
        return `Could not remove rule: ${e.message}`;
      }
    },
    log_decision: async (input) => JSON.stringify(await logDecision("chief-of-staff", input)),
    list_decisions: async ({ agent } = {}) => JSON.stringify(await listDecisions(agent || "chief-of-staff")),
    // The schema stays {agent, task}; `images` come from context, not the model.
    // The wrapper also mirrors the handoff + result to the transport's observability.
    delegate: wrapDelegateWithMirror(delegate, { onDelegate, images }),
    list_calendar: async ({ top, days } = {}) => JSON.stringify(await listEvents({ top, days })),
    fox_today: async ({ date } = {}) =>
      JSON.stringify((await getFoxToday(date)) || { note: "no Bright Horizons context captured for that day yet" }),
    ingest_fox_curriculum: async ({ url }) => {
      let parsed;
      try {
        parsed = await fetchFoxWeek(url);
      } catch (e) {
        return `Could not fetch the curriculum: ${e.message}`;
      }
      if (!parsed || !parsed.days?.length) {
        return "Could not parse that as a weekly grid. Fall back to fetch_document + set_fox_day per day.";
      }
      const saved = [];
      for (const d of parsed.days) {
        if (!d.date) continue;
        await setFoxDay(d.date, { activities: d.activities, themeOrUnit: d.themeOrUnit, clothingHint: d.clothingHint });
        saved.push(`${d.day} ${d.date}: ${d.clothingHint || "no special wardrobe"}`);
      }
      return `Saved Fox's week (${parsed.weekOf}):\n${saved.join("\n")}`;
    },
    set_fox_day: async ({ date, activities, themeOrUnit, clothingHint }) => {
      const row = await setFoxDay(date, { activities, themeOrUnit, clothingHint });
      return `Saved Fox's day ${date}. Wardrobe: ${row.clothingHint || "(none derived)"}`;
    },
    // Gated actions STAGE the side effect and return the approval ask. They do
    // NOT block the turn (that dead-locked the serial queue consumer: the turn
    // held the consumer, so the YES reply could never be read). The action runs
    // only when the family replies "YES <code>" (confirm.js executes it then).
    create_calendar_event: async (input) => {
      const who = (input.attendees || []).join(", ") || "(no invitees)";
      const when = `${input.start}${input.end ? ` – ${input.end}` : ""}`;
      const { instruction } = requestConfirmation(
        `Create event: ${input.subject}\n${when}\nInvitees: ${who}${input.showAs ? `\nShow as: ${input.showAs}` : ""}`,
        async () => {
          const r = await createEvent(input);
          return `Event created: ${r.subject}${r.webLink ? ` (${r.webLink})` : ""}`;
        }
      );
      return `Ready to create "${input.subject}" (${when}), invitees: ${who}. ${instruction}`;
    },
    send_email: async ({ to, subject, body }) => {
      const flag = isWorkDomain(to) ? " [WORK DOMAIN]" : "";
      const { instruction } = requestConfirmation(
        `Email to ${to}${flag}\nSubject: ${subject}\n${body.slice(0, 200)}`,
        async () => {
          await sendMail({ to, subject, body }); // the confirmation IS the gate (work domains flagged)
          return "Email sent.";
        }
      );
      return `Ready to email ${to}${flag} (subject: ${subject}). ${instruction}`;
    },
    fetch_document: async ({ url }) => {
      const { blocks, summaries, skipped } = await fetchDocument(url);
      if (!blocks.length) return `Could not read document: ${skipped?.[0]?.reason || "unsupported type"}`;
      return JSON.stringify({ summary: summaries.join("; "), text: blocks.map((b) => b.text).join("\n\n") });
    },
    browse_page: async ({ url, maxChars }) => {
      try {
        return JSON.stringify(await readPage(url, { maxChars }));
      } catch (e) {
        return `Could not read page: ${e.message}`;
      }
    },
    search: async ({ query, count }) => {
      try {
        const results = await webSearch(query, count ? { count } : {});
        return results.length ? JSON.stringify(results) : "No results.";
      } catch (e) {
        return `Could not search: ${e.message}`;
      }
    },
    commute_time: async ({ origin, dest }) => {
      try {
        const r = await getCommuteTime(origin, dest);
        return `${origin} to ${dest}: ${formatCommute(r)}`;
      } catch (e) {
        return `Could not get commute time: ${e.message}`;
      }
    },
    place_order: async ({ url, summary, steps }) => {
      const { instruction } = requestConfirmation(
        `Place order via browser:\n${summary}\n${url}`,
        async () => {
          const r = await runOrder({ url, steps }); // guard inside blocks read-only domains
          return `Order flow ran. Final URL: ${r.finalUrl}\nSteps: ${r.transcript.join(", ")}`;
        }
      );
      return `Ready to place this order: ${summary}. ${instruction}`;
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

// Anthropic server-side web search. Resolves inline within a single API call
// (no local handler needed), so the agentLoop just sees the final text. Billed
// per search, so we only attach it when a caller opts in (today: the morning
// digest, for live weather + traffic along each person's commute).
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 6 };

export async function runChief(body, model, { content, images, onDelegate, webSearch, history = [] } = {}) {
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
    // Prior turns (short-term memory) precede the current one so a follow-up like
    // "Nic's" resolves against "whose haircut?". `content` (text + image blocks)
    // wins for the current turn when an MMS carried photos; else plain text.
    messages: [...history, { role: "user", content: content || body }],
    tools: webSearch ? [...tools, WEB_SEARCH_TOOL] : tools,
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
  // 0. Is this a YES/NO answer to a pending approval? If so, resolve it (running
  //    the staged action on YES) and reply with the outcome on this same channel.
  const confirm = await tryResolveConfirmation(msg.body);
  if (confirm.handled) {
    if (confirm.message) await transport.reply(confirm.message);
    return;
  }

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
  //    specialist he delegates to this turn; `history` is the short-term thread
  //    so a follow-up keeps context; `onDelegate` mirrors each handoff.
  const convoKey = conversationKey(msg);
  const history = await getHistory(convoKey);
  const text = await runChief(msg.body || "(photo message)", model, {
    content,
    images,
    history,
    onDelegate: (event) => transport.mirror(event),
  });

  // 4. Deliver via the transport (channel reply for SMS/email; channel post for Slack).
  await transport.reply(text);
  // 5. Record the exchange so the next message from this sender has context.
  await appendTurn(convoKey, triageText || msg.body || "(photo message)", text);
  return text;
}

// Re-export for the heartbeat to escalate actionable items into real runs.
export { recentMailSignals };
