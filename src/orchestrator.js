import { agentLoop, systemBlocks } from "./claude.js";
import { modelForComplexity, GRAPH } from "./config.js";
import { getEmailContacts, recordEmailContact } from "./contacts.js";
import { processShipmentEmail, listActivePackages, formatPackages } from "./packages.js";
import { addTask, listTasks, completeTask, removeTask, formatTasks } from "./tasks.js";
import { createReminder, listReminders, cancelReminder } from "./reminders.js";
import { addShoppingItem, listShopping, removeShoppingItem, clearShopping, formatShopping } from "./shopping.js";
import { watchItem, listWatched, unwatchItem } from "./watch.js";
import { placeRalphsOrder } from "./grocery.js";
import { triageInbound } from "./triage.js";
import { recall, remember } from "./memory.js";
import { logDecision, listDecisions } from "./decisions.js";
import { requestConfirmation, tryResolveConfirmation, registerActionHandler } from "./confirm.js";
import { sendSms, notifyOwner } from "./channels/twilio.js";
import { extractCode as extractVerificationCode } from "./verification.js";
import { sendImessage } from "./channels/imessage.js";
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
import { computeLeaveBy } from "./leave-by.js";
import { webSearch } from "./search.js";
import { conversationKey, getHistory, appendTurn, foldThread } from "./conversation.js";
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
      "List upcoming events across the family calendars (Nic's and Shelli's, merged), read-only. Each event has a `calendars` field naming whose calendar it is on and a `showAs` field. For availability, treat showAs 'busy' OR 'tentative' as UNAVAILABLE (work calendars surface as free/busy only); only open time or showAs 'free' is bookable. `days` sets how far ahead to look (default 14): pass `days: 1` for just today (the morning digest), or a larger value to see further out, e.g. `days: 30` for the next month or `days: 60` for two months. If you are checking a specific future date, set `days` to comfortably reach it.",
    input_schema: { type: "object", properties: { top: { type: "number" }, days: { type: "number", description: "days ahead to look; default 14, up to 120" } } },
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
    name: "track_shipment",
    description:
      "Track a package from a shipping or delivery email. Pass the email's subject and body; it extracts UPS/Amazon/USPS/FedEx tracking numbers and either records the package (shipping notice) or marks it delivered (delivery confirmation). Use this whenever a shipping/delivery email arrives. Read-only to the outside world (it just stores tracking state). Returns what was tracked/delivered.",
    input_schema: {
      type: "object",
      properties: {
        subject: { type: "string" },
        body: { type: "string", description: "the email body (or full text)" },
        description: { type: "string", description: "optional: what the package is" },
      },
      required: ["body"],
    },
  },
  {
    name: "list_packages",
    description: "List the packages currently being tracked (not yet delivered). Use for 'where's my package?' / 'what's on the way?'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "add_task",
    description: "Add a to-do to the family task list. Optional `dueDate` (YYYY-MM-DD) and `owner` (e.g. Nic or Shelli). Use this for any 'add to my list / remind me to <do a thing>' that is a task, not a timed alert.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string" }, dueDate: { type: "string", description: "YYYY-MM-DD" }, owner: { type: "string" } },
      required: ["title"],
    },
  },
  {
    name: "list_tasks",
    description: "List open family tasks (overdue and due-today flagged). Set includeDone true to include completed ones. Each line ends with the task id in braces, e.g. {a1b2c3d4}.",
    input_schema: { type: "object", properties: { includeDone: { type: "boolean" } } },
  },
  {
    name: "complete_task",
    description: "Mark a task done by its id (from list_tasks) or its exact title.",
    input_schema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  },
  {
    name: "watch_item",
    description: "Watch a specific item's listing for a price drop. Pass the listing URL and optionally a targetPrice (flag when it drops to/below that) and a label. Lloyd re-checks it on the resale schedule and flags drops. Use for 'watch this item / tell me if it drops'.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" }, label: { type: "string" }, targetPrice: { type: "number" } },
      required: ["url"],
    },
  },
  {
    name: "list_watched",
    description: "List the items being price-watched (with last seen price and any target).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "unwatch_item",
    description: "Stop watching an item by its id (from list_watched) or its URL.",
    input_schema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
  },
  {
    name: "add_shopping_item",
    description: "Add an item to the family shopping list (optional quantity and note). The list is for review/handoff; it does NOT order anything. Carmine can also add low/expiring items here.",
    input_schema: {
      type: "object",
      properties: { item: { type: "string" }, quantity: { type: "string" }, note: { type: "string" } },
      required: ["item"],
    },
  },
  {
    name: "list_shopping",
    description: "Show the family shopping list. Use for 'what's on the shopping list?' / 'what do we need?'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "remove_shopping_item",
    description: "Remove an item from the shopping list by its id (from list_shopping) or name. Pass clearAll true to empty the whole list (e.g. after a shopping run).",
    input_schema: { type: "object", properties: { item: { type: "string" }, clearAll: { type: "boolean" } } },
  },
  {
    name: "add_reminder",
    description: "Set a timed reminder that fires at a specific time (you get the current time in context, so compute the exact moment). `fireAt` is an ISO datetime in the family timezone, e.g. 2026-06-25T17:00:00. Optional `recurrence`: daily, weekdays, or weekly. Use this for time-based alerts ('remind me at 5pm', 'every weekday at 8'); use add_task for an untimed to-do.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string" },
        fireAt: { type: "string", description: "ISO datetime in the family tz, e.g. 2026-06-25T17:00:00" },
        recurrence: { type: "string", enum: ["daily", "weekdays", "weekly"] },
      },
      required: ["message", "fireAt"],
    },
  },
  {
    name: "list_reminders",
    description: "List pending reminders (soonest first), each with its id.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its id (from list_reminders).",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "search",
    description:
      "Search the web (read-only) and get back ranked results as {title, url, snippet}. Use it to find an address, hours, a fact, or a listing; then read the best hit with browse_page. Acting on a result (email/buy) still routes through the confirmation gate.",
    input_schema: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query"] },
  },
  {
    name: "leave_by",
    description:
      "Work out when to LEAVE to arrive on time, using live traffic (Azure Maps) plus a buffer. Pass origin, destination, and arriveBy (ISO datetime in the family tz). Set setReminder true to also arm a reminder at the leave-by time. Use for 'when do I need to leave for X?' or to set a leave-by nudge for an appointment.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "start address (usually home)" },
        destination: { type: "string" },
        arriveBy: { type: "string", description: "ISO datetime to arrive by, e.g. 2026-06-25T14:00:00" },
        bufferMin: { type: "number", description: "minutes of cushion (default 10)" },
        setReminder: { type: "boolean", description: "also arm a reminder at the leave-by time" },
      },
      required: ["origin", "destination", "arriveBy"],
    },
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

// Executors for the gated actions, keyed by the `kind` staged in confirm.js. They
// run ONLY when an approval is confirmed (the YES reply or a Slack Approve tap),
// possibly in a different process than the one that staged it (restart-safe), so
// they take serializable params, not closures. Registered once at module load.
registerActionHandler("calendar", async (input) => {
  const r = await createEvent(input);
  return `Event created: ${r.subject}${r.webLink ? ` (${r.webLink})` : ""}`;
});
registerActionHandler("email", async ({ to, subject, body }) => {
  await sendMail({ to, subject, body }); // the confirmation IS the gate (work domains flagged at stage time)
  await recordEmailContact(to); // remember we've now written them, so next time isn't "first contact"
  return "Email sent.";
});
registerActionHandler("order", async ({ url, steps }) => {
  const r = await runOrder({ url, steps }); // guard inside blocks read-only domains
  return `Order flow ran. Final URL: ${r.finalUrl}\nSteps: ${r.transcript.join(", ")}`;
});
// The weekly Ralphs grocery order (assembled Friday from the shopping list). Runs
// on Lloyd's local Mac (real IP) only after the family approves; placeRalphsOrder
// handles the slow, signed-in-Chrome checkout (live steps pending).
registerActionHandler("grocery", async (order) => placeRalphsOrder(order));

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
export function transportFor(msg, { onSms = sendSms, onMail = sendMail, onReply = replyToMessage, onImessage = sendImessage } = {}) {
  if (msg.channel === "imessage") {
    // replyTo carries the BlueBubbles chatGuid so the reply lands in the exact
    // existing thread (incl. group chats); fall back to the raw handle for a 1:1.
    return { reply: (text) => onImessage(msg.replyTo || msg.from, text), mirror: noop };
  }
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
    // NOT block the turn (that dead-locked the serial queue consumer). The action
    // runs only when the family replies "YES <code>"; the staged kind+params are
    // persisted (confirm.js) so a restart can't drop a pending approval.
    create_calendar_event: async (input) => {
      const who = (input.attendees || []).join(", ") || "(no invitees)";
      const when = `${input.start}${input.end ? ` – ${input.end}` : ""}`;
      const { instruction } = await requestConfirmation(
        `Create event: ${input.subject}\n${when}\nInvitees: ${who}${input.showAs ? `\nShow as: ${input.showAs}` : ""}`,
        "calendar",
        input
      );
      return `Ready to create "${input.subject}" (${when}), invitees: ${who}. ${instruction}`;
    },
    send_email: async ({ to, subject, body }) => {
      const flag = isWorkDomain(to) ? " [WORK DOMAIN]" : "";
      // Append Lloyd's signature so every outbound email is signed consistently
      // (he's told not to add his own sign-off). Stored on the staged action so
      // the approved send matches the preview.
      const signed = `${String(body).trimEnd()}\n\n${GRAPH.signature}`;
      const { instruction } = await requestConfirmation(
        `Email to ${to}${flag}\nSubject: ${subject}\n${signed.slice(0, 220)}`,
        "email",
        { to, subject, body: signed }
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
    track_shipment: async ({ subject, body, description }) => {
      const r = await processShipmentEmail({ subject, body, description });
      if (!r.found.length) return "No tracking numbers found in that email.";
      const fmt = (a) => a.map((n) => `${n.carrier} ${n.trackingNumber}`).join(", ");
      if (r.isDelivery) return `Marked delivered: ${fmt(r.delivered)}.`;
      return `Now tracking: ${fmt(r.tracked)}.`;
    },
    list_packages: async () => formatPackages(await listActivePackages()),
    add_task: async ({ title, dueDate, owner }) => {
      try {
        const t = await addTask({ title, dueDate, owner });
        return `Added task: "${t.title}"${t.dueDate ? ` (due ${t.dueDate})` : ""}${t.owner ? ` for ${t.owner}` : ""} {${t.id}}`;
      } catch (e) {
        return `Could not add task: ${e.message}`;
      }
    },
    list_tasks: async ({ includeDone } = {}) => formatTasks(await listTasks({ includeDone })),
    complete_task: async ({ task }) => {
      const t = await completeTask(task);
      return t ? `Marked done: "${t.title}"` : "No matching open task found.";
    },
    watch_item: async ({ url, label, targetPrice }) => {
      try {
        const it = await watchItem({ url, label, targetPrice });
        return `Watching "${it.label}"${it.targetPrice != null ? ` (target $${it.targetPrice})` : ""} {${it.id}}. I'll flag a price drop.`;
      } catch (e) {
        return `Could not watch that item: ${e.message}`;
      }
    },
    list_watched: async () => {
      const items = await listWatched();
      if (!items.length) return "Not watching any items.";
      return items.map((i) => `- ${i.label}: ${i.lastPrice != null ? `$${i.lastPrice}` : "price unknown"}${i.targetPrice != null ? ` (target $${i.targetPrice})` : ""} {${i.id}}\n  ${i.url}`).join("\n");
    },
    unwatch_item: async ({ item }) => {
      const it = await unwatchItem(item);
      return it ? `Stopped watching "${it.label}".` : "No matching watched item found.";
    },
    add_shopping_item: async ({ item, quantity, note }) => {
      try {
        const { item: it, merged } = await addShoppingItem({ item, quantity, note });
        return `${merged ? "Updated" : "Added"} on the shopping list: ${it.item}${it.quantity ? ` (${it.quantity})` : ""} {${it.id}}`;
      } catch (e) {
        return `Could not add to the shopping list: ${e.message}`;
      }
    },
    list_shopping: async () => formatShopping(await listShopping()),
    remove_shopping_item: async ({ item, clearAll }) => {
      if (clearAll) return `Cleared the shopping list (${await clearShopping()} items).`;
      const it = await removeShoppingItem(item);
      return it ? `Removed from the shopping list: ${it.item}` : "No matching shopping item found.";
    },
    add_reminder: async ({ message, fireAt, recurrence }) => {
      try {
        const { reminder, deduped } = await createReminder({ message, fireAt, recurrence });
        const when = new Date(reminder.fireAt).toLocaleString("en-US", { timeZone: FAMILY_TZ, dateStyle: "medium", timeStyle: "short" });
        return `${deduped ? "Already set" : "Reminder set"}: "${reminder.message}" at ${when}${reminder.recurrence ? ` (${reminder.recurrence})` : ""} {${reminder.id}}`;
      } catch (e) {
        return `Could not set reminder: ${e.message}`;
      }
    },
    list_reminders: async () => {
      const rs = await listReminders();
      if (!rs.length) return "No pending reminders.";
      return rs.map((r) => `${new Date(r.fireAt).toLocaleString("en-US", { timeZone: FAMILY_TZ, dateStyle: "medium", timeStyle: "short" })}: ${r.message}${r.recurrence ? ` (${r.recurrence})` : ""} {${r.id}}`).join("\n");
    },
    cancel_reminder: async ({ id }) => {
      const r = await cancelReminder(id);
      return r ? `Cancelled reminder: "${r.message}"` : "No matching reminder found.";
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
    leave_by: async ({ origin, destination, arriveBy, bufferMin, setReminder }) => {
      try {
        const r = await computeLeaveBy({ origin, destination, arriveBy, ...(bufferMin != null ? { bufferMin } : {}) });
        const when = new Date(r.leaveBy).toLocaleString("en-US", { timeZone: FAMILY_TZ, dateStyle: "medium", timeStyle: "short" });
        let out = `Leave by ${when} for ${destination} (${r.driveMin} min drive, ${r.trafficLabel}, +${r.bufferMin} min buffer).`;
        if (setReminder) {
          const { reminder } = await createReminder({ message: `Leave now for ${destination}`, fireAt: r.leaveBy });
          out += ` Reminder set {${reminder.id}}.`;
        }
        return out;
      } catch (e) {
        return `Could not compute leave-by time: ${e.message}`;
      }
    },
    place_order: async ({ url, summary, steps }) => {
      const { instruction } = await requestConfirmation(
        `Place order via browser:\n${summary}\n${url}`,
        "order",
        { url, summary, steps }
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
  const contacts = await getEmailContacts(); // so Lloyd knows who is NOT a first contact
  const volatile = [
    `Now: ${nowInFamilyTz()}`,
    formatHouseRules(rules),
    contacts.length
      ? `Email addresses you have written before (anyone NOT on this list is a first contact, so introduce yourself): ${contacts.join(", ")}`
      : "You have no record of emailing anyone yet, so treat any outbound email as a first contact and introduce yourself.",
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
export async function collectAttachments(msg, { fetchImpl = fetch } = {}) {
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    const out = [];
    for (const a of msg.attachments) {
      let bytes = a.bytes ?? (a.contentBytes ? Buffer.from(a.contentBytes, "base64") : undefined);
      // URL-based attachments (iMessage/BlueBubbles): download the bytes so the
      // document parser gets them, the same pre-download the Slack path does. The
      // BlueBubbles URL carries its own auth (password query param), so no header.
      if (bytes == null && a.url) {
        try {
          const res = await fetchImpl(a.url);
          if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
          else log.warn("attachment download failed", { name: a.name, status: res.status });
        } catch (err) {
          log.warn("attachment download error", { name: a.name, reason: err.message });
        }
      }
      if (bytes != null) out.push({ name: a.name, contentType: a.contentType, bytes });
    }
    return out;
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
export async function handleInbound(msg, transport = transportFor(msg), { forceAgent = null } = {}) {
  // 0. Is this a YES/NO answer to a pending approval? If so, resolve it (running
  //    the staged action on YES) and reply with the outcome on this same channel.
  const confirm = await tryResolveConfirmation(msg.body);
  if (confirm.handled) {
    if (confirm.message) await transport.reply(confirm.message);
    return;
  }

  // 0a. Verification / one-time codes: relay the code to the owner immediately.
  //     Runs BEFORE the auto-reply suppression below, because OTP emails usually
  //     come from no-reply senders that the suppressor (rightly) drops — we still
  //     want the code. Conservative matcher (keyword + 4-8 digit), so low noise.
  if (msg.channel === "email") {
    const code = extractVerificationCode(msg.subject, msg.body);
    if (code) {
      const from = msg.from ? ` (from ${msg.from})` : "";
      await notifyOwner(`Verification code: ${code}${from}`);
      log.info("verification code relayed", { from: msg.from });
      return;
    }
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
    const { imageBlocks, skipped } = await fetchInboundMedia(msg.media);
    if (imageBlocks.length) {
      images = imageBlocks; // forwarded to specialists on delegate
      extraBlocks.push(...imageBlocks);
      triageNotes.push(`${imageBlocks.length} photo(s)`);
    }
    // An image Claude can't read (e.g. iPhone HEIC) must NOT silently vanish — tell
    // Lloyd so he asks for a resend, instead of answering an empty "(shared a file)".
    const unreadable = skipped.filter((s) => s.reason && !/capped|too large/.test(s.reason));
    if (unreadable.length) {
      extraBlocks.push({
        type: "text",
        text: `[Note: ${unreadable.length} attached image(s) could not be read: ${unreadable[0].reason}. Tell the sender what happened and ask them to resend as JPEG or PNG.]`,
      });
      triageNotes.push(`${unreadable.length} unreadable image(s)`);
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

  // 2. Memory key. A forced per-agent channel (e.g. Slack #resale) shares ONE
  //    thread for the whole channel (channel+agent), so text and photos posted
  //    there build the same context; everything else is keyed per sender.
  const convoKey = forceAgent
    ? conversationKey({ channel: `${msg.channel}:${forceAgent}`, from: msg.replyTo || msg.from })
    : conversationKey(msg);
  const history = await getHistory(convoKey);

  // 3. Run it. A forced channel talks STRAIGHT to its specialist (no triage, no
  //    chief) but with the channel's shared memory: the thread + any extracted
  //    document text fold into the task (the delegate seam is text-only) and
  //    images ride the `images` param so the specialist sees the actual photo.
  //    Otherwise: triage to the cheapest sufficient model and run the chief, who
  //    sees `content` (images inline) and may delegate (forwarding `images`).
  let text;
  if (forceAgent) {
    const textExtras = extraBlocks.filter((b) => b.type === "text").map((b) => b.text);
    const body = [msg.body?.trim() || "", ...textExtras].filter(Boolean).join("\n\n") || "(photo message)";
    text = await delegate({ agent: forceAgent, task: foldThread(history, body), images });
  } else {
    const t = await triageInbound(triageText);
    const model = modelForComplexity(t.complexity, t.high_stakes);
    text = await runChief(msg.body || "(photo message)", model, {
      content,
      images,
      history,
      onDelegate: (event) => transport.mirror(event),
    });
  }

  // 4. Deliver via the transport (channel reply for SMS/email; channel post for Slack).
  await transport.reply(text);
  // 5. Record the exchange so the next message from this sender has context.
  await appendTurn(convoKey, triageText || msg.body || "(photo message)", text);
  return text;
}

// Re-export for the heartbeat to escalate actionable items into real runs.
export { recentMailSignals };
