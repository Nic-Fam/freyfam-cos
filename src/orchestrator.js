import { agentLoop, systemBlocks } from "./claude.js";
import { modelForComplexity, modelForTurn, GRAPH, BUDGET } from "./config.js";
import { getEmailContacts, recordEmailContact } from "./contacts.js";
import { processShipmentEmail, listActivePackages, formatPackages, isShippingEmail, isDeliveryConfirmation } from "./packages.js";
import { addTask, listTasks, completeTask, removeTask, formatTasks } from "./tasks.js";
import { dismissAlert } from "./heartbeat-alerts.js";
import { createReminder, listReminders, cancelReminder } from "./reminders.js";
import { addShoppingItem, listShopping, removeShoppingItem, clearShopping, formatShopping } from "./shopping.js";
import { watchItem, listWatched, unwatchItem } from "./watch.js";
import { dismissBoutiqueListings } from "./boutique-feed.js";
import { placeRalphsOrder, gatherGroceryItems } from "./grocery.js";
import { buildGroceryPlaybook } from "./grocery-order-playbook.js";
import { buildCvsOtcPlaybook } from "./pharmacy-order-playbook.js";
import { planRxSync, formatRxPlan } from "./rx.js";
import { triageInbound } from "./triage.js";
import { recall, remember } from "./memory.js";
import { logDecision, listDecisions } from "./decisions.js";
import { requestConfirmation, tryResolveConfirmation, registerActionHandler } from "./confirm.js";
import { notifyOwner } from "./channels/notify.js";
import { extractCode as extractVerificationCode } from "./verification.js";
import { sendImessage, sendImessageAudio } from "./channels/imessage.js";
import { recentMailSignals, sendMail, sendVoiceMail, sendMailWithAttachment, createDraft, fetchAttachments, listEvents, createEvent, deleteEvent, replyToMessage, listTodoTasks, addTodoTask } from "./channels/graph.js";
import { calendarGateDecision } from "./calendar-gate.js";
import { findConflicts } from "./week-conflicts.js";
import { isReceipt, captureReceipt, listReceipts, formatReceipts } from "./receipts.js";
import { synthesizeSpeech, ttsConfigured } from "./tts.js";
import { persona } from "./persona.js";
import { delegate } from "./delegate.js";
import { cooRoster, companyAgent } from "./companies.js";
import { fulfillCooRequests } from "./coo-requests.js";
import { readPage, readPageHeaded, runOrder } from "./channels/browser.js";
import { findFoodOrders, resolveReorder, formatFoodOrders, formatReorder, placeFoodOrder } from "./food-delivery.js";
import { resyAvailability, slotsNear, resyBook, minutesOfDay, openTableAvailability, openTableBook, venuePlatform } from "./reservations.js";
import * as downsizing from "./downsizing.js";
import { postListing, pullListing, PLATFORM_LABEL } from "./listings.js";
import { fetchAmazonOrders, summarizeNeeds } from "./amazon-orders.js";
import { budgetStatus, formatBudget } from "./budget.js";
import { ingestChaseCsv, isChaseCsvAttachment } from "./chase-csv.js";
import { budgetChartSvg, renderBudgetChartPng } from "./budget-chart.js";
import { printDocument, listPrinters } from "./channels/printer.js";
import { fetchInboundMedia } from "./media.js";
import { extractDocuments, fetchDocument } from "./documents.js";
import { extractAudio, isAudioAttachment } from "./audio.js";
import { isTransactionAlert, queueAlert } from "./finance-ingest.js";
import { getHouseRules, formatHouseRules, getAgentRules, addRule, removeRule, KNOWN_AGENTS } from "./rules.js";
import { getFoxToday, setFoxDay } from "./fox.js";
import { fetchFoxWeek } from "./fox-curriculum.js";
import { getCommuteTime, formatCommute } from "./commute.js";
import { getWeather, formatWeather } from "./weather.js";
import { computeLeaveBy } from "./leave-by.js";
import { webSearch } from "./search.js";
import { conversationKey, getHistory, appendTurn, foldThread } from "./conversation.js";
import { isWorkDomain, shouldAutoReply, isSelfAddress, isFamilyAddress, isAuthorizedSender } from "./guards.js";
import { logAction, listActions, formatAudit } from "./audit.js";
import { getMealsInRange } from "./meals.js";
import { mealsToGroceryItems } from "./meal-grocery.js";
import { formatDashboard } from "./dashboard.js";
import { routingHints } from "./routing.js";
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
    description:
      "Hand a scoped task to a specialist OR a company COO and get their result. Specialists: 'finance', 'dev', 'resale', 'chef' (meals + kitchen), 'security' (home + IT). COOs run a company end to end (e.g. '" + (cooRoster()[0]?.key || "sasshey-coo") + "'): give one a management task and it returns its plan plus any REQUESTS (for a specialist, a heavy lift by Nic, or a gated action). I fulfill those requests for it behind the confirmation gate and fold the results into the result you get back.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["finance", "dev", "resale", "chef", "security", ...cooRoster().map((c) => c.key)] },
        task: { type: "string" },
      },
      required: ["agent", "task"],
    },
  },
  {
    name: "list_calendar",
    description:
      "List upcoming events across the family calendars (Nic's and Shelli's, merged), read-only. Each event has a `day` field with the AUTHORITATIVE weekday + date (e.g. 'Saturday, Jun 27'): use it verbatim whenever you name a day, and NEVER compute the weekday yourself from the date (you get it wrong, e.g. calling Sat Jun 27 'Friday', which shifts availability onto the wrong day). Each event also has a `calendars` field naming whose calendar it is on and a `showAs` field. For availability, treat showAs 'busy' OR 'tentative' as UNAVAILABLE (work calendars surface as free/busy only); only open time or showAs 'free' is bookable. `days` sets how far ahead to look (default 14): pass `days: 1` for just today (the morning digest), or a larger value to see further out, e.g. `days: 30` for the next month or `days: 60` for two months. If you are checking a specific future date, set `days` to comfortably reach it.",
    input_schema: { type: "object", properties: { top: { type: "number" }, days: { type: "number", description: "days ahead to look; default 14, up to 120" }, back: { type: "number", description: "also include events from this many days BEFORE today (default 0). Use back: 1 in the morning digest to review what just happened yesterday and spawn follow-ups." } } },
  },
  {
    name: "fox_today",
    description:
      "Get Fox's Woodbury Preschool day: activities, theme, and a wardrobe hint (e.g. old clothes on paint days, a change of clothes on water days). Read-only.",
    input_schema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; defaults to today" } } },
  },
  {
    name: "ingest_fox_curriculum",
    description:
      "Fetch a Woodbury Preschool WEEKLY curriculum PDF link and save Fox's activities PER DAY automatically (one entry per weekday, with a wardrobe hint each). Use this on a Woodbury Preschool email. Returns what was saved.",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "set_fox_day",
    description:
      "Save Fox's Woodbury Preschool activities for ONE day (fallback / manual correction; prefer ingest_fox_curriculum for a weekly PDF). A wardrobe hint is derived automatically from the activities (paint/messy -> old clothes; water -> a full change + towel). Operates only on the family's own data; no outbound.",
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
    name: "delete_calendar_event",
    description:
      "Delete (cancel) a calendar event. High-stakes and irreversible (removes the event and notifies any attendees): requires owner approval. First call list_calendar to find the event, then pass that event's `refs` array (its mailbox+id handle(s)) and `subject` here verbatim — do NOT invent refs. An event on both calendars carries multiple refs and is removed from both.",
    input_schema: {
      type: "object",
      properties: {
        refs: {
          type: "array",
          description: "The `refs` array copied from the list_calendar event to delete.",
          items: {
            type: "object",
            properties: { calendar: { type: "string" }, id: { type: "string" } },
            required: ["calendar", "id"],
          },
        },
        subject: { type: "string", description: "Event title, for the approval prompt + audit log." },
        start: { type: "string", description: "ISO start of the event, for the approval prompt (optional)." },
      },
      required: ["refs", "subject"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email from the assistant mailbox. High-stakes: requires owner approval. To copy people, use the `cc`/`bcc` fields (comma-separated) -- do NOT write 'CC:'/'BCC:' lines in the body, those are just text and do not actually copy anyone. To loop Nic/Shelli in, CC their address here so they really receive it.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string", description: "optional CC recipients, comma-separated" },
        bcc: { type: "string", description: "optional BCC recipients, comma-separated" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "draft_email",
    description:
      "Write an email on a family member's behalf and SAVE IT AS A DRAFT in their OWN mailbox (default Nic's nic@freyfam.com). It is NEVER sent -- it lands in their Drafts folder so they can review, edit, and send it themselves. VOICE: write the body in the ACCOUNT OWNER'S OWN first-person voice, as if Nic (or Shelli) wrote it themselves -- no Lloyd sign-off, no 'Lloyd here', no third person. ONLY write it in Lloyd's own voice if the family EXPLICITLY asks for an email FROM Lloyd/the assistant. Use this whenever the family wants you to compose an email for them rather than send it, or when you'd otherwise propose sending but they'd rather send it personally. No approval needed, because nothing goes out. Use `cc`/`bcc` fields (comma-separated), not 'CC:' lines in the body.",
    input_schema: {
      type: "object",
      properties: {
        account: { type: "string", enum: ["nic", "shelli"], description: "whose Drafts folder to save into (default nic)" },
        to: { type: "string" },
        cc: { type: "string", description: "optional CC recipients, comma-separated" },
        bcc: { type: "string", description: "optional BCC recipients, comma-separated" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "browse_and_report",
    description:
      "Open a page in Lloyd's SIGNED-IN browser (HEADED on the Mac) and report its visible text — for authenticated sites or ones that block the plain reader (account pages, portals, dashboards, reservation/booking pages). READ-ONLY: never clicks, fills, submits, or buys. Give the URL and optionally what you're checking; answer from the returned text. For a plain public page, prefer browse_page (faster, headless).",
    input_schema: { type: "object", properties: { url: { type: "string" }, looking_for: { type: "string", description: "what to check/answer (optional)" } }, required: ["url"] },
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
    name: "amazon_orders",
    description:
      "Read the family's recent Amazon order history (status + spend) in the local signed-in browser. Read-only, slow crawl — never buys. Returns { signedIn, orders:[{orderId, placedDate, total, status, deliveryLine, items:[{title, consumable, need}]}], needsSummary }. Each item carries `need`: needed | discretionary | gray (coffee/optional recurring). `needsSummary` = {neededCount, grayCount, discretionary:[...], gray:[...]} for a quick needed-vs-discretionary read. status is delivered/arriving/shipped/ordered/cancelled/returned. Use it for 'what did we order / where is it / how much / what's discretionary on Amazon', then delegate the analysis: send the orders to finance (Patrick) for the spend + discretionary breakdown and to chef (Carmine) for consumable/pantry restock + delivery timing (the browser only runs here on Lloyd, so specialists can't crawl it themselves). If signedIn is false, relay the `note`. `pages` = how far back (default 2, ~10 orders/page, max 6).",
    input_schema: {
      type: "object",
      properties: {
        pages: { type: "number", description: "history pages to crawl, ~10 orders each (default 2, max 6)" },
        maxOrders: { type: "number" },
      },
    },
  },
  {
    name: "budget_status",
    description:
      "Where the family is on this month's budget: cumulative spend as a % of monthly income, day-by-day, against the savings-goal spend cap (income minus the savings rate). Counts Patrick-visible spend PLUS known off-book fixed commitments (e.g. Shelli's student loan). Read-only. Use it for 'how are we doing on the budget / are we on track to save this month'. Returns a text summary; call budget_chart to also send the day-by-day chart image.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "budget_chart",
    description:
      "Render the month's budget-burn chart (cumulative spend % vs the savings-cap line, day-by-day) and EMAIL it to the owner as a PNG. Use when the family wants to see the trend, not just the number. Read-only (self-report to the owner, no third party). Falls back to the text summary if the image can't be rendered.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "fetch_document",
    description:
      "Fetch a document at a URL and return its text. Handles PDF, .ics (calendar), and .vcf (contact). Read-only. Use for document LINKS in an email body — e.g. a Woodbury Preschool curriculum PDF link. For Fox's curriculum, then call set_fox_day with the activities.",
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
    name: "list_receipts",
    description: "List vendor/food receipts the family auto-forwarded to the mailbox (captured automatically), newest first: date, vendor, total, and whether it's a grocery receipt. Read-only. Use it for spend (delegate the totals to finance/Patrick) and for pantry (grocery receipts -> food coming into the kitchen, for chef/Carmine). `sinceDays` defaults 14; `kind` filters to 'grocery' or 'prepared'.",
    input_schema: { type: "object", properties: { sinceDays: { type: "number" }, kind: { type: "string", enum: ["grocery", "prepared", "other"] } } },
  },
  {
    name: "order_playbook",
    description: "Get the Claude-in-Chrome operator playbook to place a store order, prefilled with the current shopping-list items. `store` = 'ralphs' | 'costco' | 'cvs' (OTC). READ-ONLY: it returns step-by-step instructions to run in the family's signed-in Chrome (fill cart, apply the Friday 4x-fuel coupon for Ralphs, drop out-of-stock, STOP at review). It does NOT open a browser or buy anything — a Claude Code session runs it, and the order is placed only after the family approves the reviewed cart (confirm.js).",
    input_schema: { type: "object", properties: { store: { type: "string", enum: ["ralphs", "costco", "cvs"] } }, required: ["store"] },
  },
  {
    name: "complete_task",
    description: "Mark a task done by its NUMBER from the morning digest / list_tasks (a bare 1-2 digit number = its position in the current open-task list, e.g. \"2\"), its id (from list_tasks), or its exact title.",
    input_schema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
  },
  {
    name: "dismiss_alert",
    description: "Stop a recurring PROACTIVE heads-up once the family has acknowledged or handled it (e.g. 'yes, I submitted that Amazon data request, stop flagging it' or 'that alert is fine, clear it'). Pass the topic in your own words including its distinctive nouns; it's matched by keywords so future heartbeat alerts about the SAME thing are suppressed for good. Use ONLY when the family clears/acknowledges a proactive flag — not for their normal requests.",
    input_schema: { type: "object", properties: { topic: { type: "string", description: "the alert topic + its key nouns, e.g. 'Amazon DSAR data request confirmation'" } }, required: ["topic"] },
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
    name: "dismiss_resale_listing",
    description:
      "Permanently stop surfacing specific resale/boutique listings the family said aren't right. Pass the listing URL(s) — take them from the family's message and the quoted alert it replies to. Those exact listings will never appear in future new-arrivals alerts. Use whenever the family replies to a resale/boutique 'new arrivals' alert saying the finds aren't right, they're not interested, or to stop showing them. Low-stakes and reversible; no confirmation needed.",
    input_schema: {
      type: "object",
      properties: { urls: { type: "array", items: { type: "string" }, description: "Listing URLs to stop showing (from the alert/reply)." } },
      required: ["urls"],
    },
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
    name: "read_store_list",
    description:
      "Read a store's Microsoft To Do shopping list (the list the family fills by voice at the fridge via Alexa). store is 'Ralphs' or 'Costco'. Use for 'what's on the Ralphs/Costco list?'. Read-only.",
    input_schema: { type: "object", properties: { store: { type: "string", enum: ["Ralphs", "Costco", "Amazon Shopping List"] } }, required: ["store"] },
  },
  {
    name: "add_to_store_list",
    description:
      "Add an item to a store's Microsoft To Do shopping list — the SAME lists the Friday grocery order reads (and the Siri 'restock' shortcut fills). 'restock' is the family's standard phrase for this, so treat it as the trigger: use this tool when the family says 'restock milk on the Ralphs list', 'restock paper towels for Costco', 'add eggs to the Ralphs list', 'put butter on the Costco list', etc. store is 'Ralphs', 'Costco', or 'Amazon Shopping List' (default Ralphs if unspecified). Does not order anything.",
    input_schema: { type: "object", properties: { store: { type: "string", enum: ["Ralphs", "Costco", "Amazon Shopping List"] }, item: { type: "string" } }, required: ["store", "item"] },
  },
  {
    name: "meals_to_grocery_list",
    description:
      "Turn the planned meals over a date range into a grocery list: collect their ingredients and add them to a store's To Do list (default Ralphs). Use for 'add this week's dinners to the shopping list'. Dates YYYY-MM-DD; store optional. Only meals that have ingredients contribute.",
    input_schema: { type: "object", properties: { startDate: { type: "string" }, endDate: { type: "string" }, store: { type: "string", enum: ["Ralphs", "Costco", "Amazon Shopping List"] } }, required: ["startDate", "endDate"] },
  },
  {
    name: "recent_actions",
    description:
      "Show what you (Lloyd) have actually done recently — the audit log of outbound actions (emails sent, calendar events, orders). Use for 'what have you done this week?' / 'did you send that email?'. `days` optional (default 7). Read-only.",
    input_schema: { type: "object", properties: { days: { type: "number" } } },
  },
  {
    name: "show_today",
    description:
      "Build a quick 'today' card: schedule, Fox's day + wardrobe, meals, due/overdue tasks, packages arriving. A fast deterministic snapshot (no research). Use for 'what's today?' / 'give me the rundown'.",
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
    name: "find_reservation",
    description:
      "Check restaurant reservation availability on Resy (READ-ONLY; never books). Give `restaurant` (a name like \"Union Pasadena\", or a resy.com venue URL), a `date` (YYYY-MM-DD), `partySize`, and optionally a target `time` like \"7:00 PM\". Returns { venue, date, partySize, url, slots:[{time, types}] }, nearest the target time first when given. Runs the signed-in browser HEADED on Lloyd's Mac. Actually BOOKING a slot is a separate high-stakes step that goes through the confirmation gate — this tool only reports what's open.",
    input_schema: { type: "object", properties: { restaurant: { type: "string", description: "restaurant name or a resy.com venue URL" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "desired time e.g. '7:00 PM' (optional)" }, partySize: { type: "number", description: "default 2" } }, required: ["restaurant", "date"] },
  },
  {
    name: "make_reservation",
    description:
      "BOOK a restaurant reservation on Resy. HIGH-STAKES — always goes through the confirmation gate; it never books without the owner's YES. Give `restaurant` (name or resy.com URL), `date` (YYYY-MM-DD), `time` (e.g. '7:00 PM'), and `partySize`. It verifies a slot is open near that time, then STAGES the booking for approval; on YES it completes it headed on Lloyd's Mac and reports the confirmation. It NEVER enters card details — if a deposit/card is required it says so. Use find_reservation first to just see what's open.",
    input_schema: { type: "object", properties: { restaurant: { type: "string", description: "restaurant name or a resy.com venue URL" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "desired time e.g. '7:00 PM'" }, partySize: { type: "number", description: "default 2" } }, required: ["restaurant", "date", "time"] },
  },
  {
    name: "add_listing_item",
    description:
      "DOWNSIZING PROGRAM (one-off move sale). Add an item the family wants to sell across Craigslist / Facebook Marketplace / Nextdoor. Any PHOTOS attached to the current message are saved with the item automatically. Write a clean marketplace `title` and `description` yourself (you can see the photo), suggest a `priceAsk` (use the `search` tool for comps if unsure), and set `category`/`condition` when clear. `platforms` defaults to all three. Returns the created item with its id. Use this when Nic sends a picture + says to sell/list something for the move.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "short marketplace title, e.g. 'West Elm Mid-Century Sofa, Walnut'" },
        description: { type: "string", description: "buyer-facing description: what it is, condition, size, why selling" },
        priceAsk: { type: "number", description: "asking price in dollars" },
        category: { type: "string", description: "e.g. furniture, appliances, kids, electronics" },
        condition: { type: "string", description: "e.g. like new, good, fair" },
        dimensions: { type: "string", description: "size/dimensions if relevant (furniture)" },
        notes: { type: "string", description: "private notes (pickup only, firm price, etc.)" },
        platforms: { type: "array", items: { type: "string", enum: ["craigslist", "facebook", "nextdoor"] }, description: "which platforms to list on (default all three)" },
      },
      required: ["title"],
    },
  },
  {
    name: "list_downsizing",
    description: "Show the downsizing sale items and their status (draft / active / sold / pulled) and which platforms each is live on. Optional `status` filter. Use for 'what are we selling', 'what's still up', 'move sale status'.",
    input_schema: { type: "object", properties: { status: { type: "string", enum: ["draft", "active", "sold", "pulled"], description: "optional status filter" } } },
  },
  {
    name: "update_listing_item",
    description:
      "Edit a downsizing item, or record that a platform listing went live/changed. Match by `item` (id or title). Change any of title/description/priceAsk/category/condition/notes. To record that Nic posted it: set `platform` plus `platformStatus` ('listed' when live, 'pulled' when removed) and the live `platformUrl`. Use when Nic says 'the sofa is up on Facebook, here's the link' or 'drop the price to 200'.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "item id or title" },
        title: { type: "string" }, description: { type: "string" }, priceAsk: { type: "number" },
        category: { type: "string" }, condition: { type: "string" }, notes: { type: "string" },
        platform: { type: "string", enum: ["craigslist", "facebook", "nextdoor"] },
        platformStatus: { type: "string", enum: ["draft", "listed", "pending", "pulled"] },
        platformUrl: { type: "string", description: "the live listing URL on that platform" },
      },
      required: ["item"],
    },
  },
  {
    name: "post_listing",
    description:
      "Auto-fill an item's listing on one platform (craigslist/facebook/nextdoor) on the signed-in browser, STOP before publishing, and return a resume link so Nic finishes and taps Post himself (the chosen 'auto-fill, you confirm' flow). It never publishes on its own. Runs HEADED on Lloyd's Mac; the platform must be signed in there. If a field can't be filled it says which, so Nic can complete it. After Nic posts, call update_listing_item with the live URL to track it.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "item id or title" },
        platform: { type: "string", enum: ["craigslist", "facebook", "nextdoor"] },
      },
      required: ["item", "platform"],
    },
  },
  {
    name: "price_item",
    description:
      "Have Shey (resale specialist) recommend a price for something you're selling. Give an `item` (id or title from the downsizing list) OR describe it with `title` plus optional `description`/`condition`/`category`. Shey pulls comparable sold + active listings (eBay, marketplaces) and returns a suggested ASKING price, a low/target/high range tuned for a QUICK local sale (the family is moving soon), and a short rationale. Set `apply:true` to also save the suggested price onto that downsizing item. Use for 'what should I ask for the sofa?', 'price this', or pricing help during the move sale.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "downsizing item id or title (optional if you describe it)" },
        title: { type: "string", description: "what it is, if not already an item" },
        description: { type: "string" }, condition: { type: "string" }, category: { type: "string" },
        apply: { type: "boolean", description: "save the suggested price onto the item (default false)" },
      },
    },
  },
  {
    name: "mark_item_sold",
    description:
      "Mark a downsizing item SOLD. Records the sale (optional `platform` it sold on and `price`), then AUTO-PULLS it from every OTHER platform it is still live on by staging a take-down through the confirmation gate (Nic approves with YES). Use when Nic says 'the dresser sold' or 'mark the bikes sold on Facebook for 150'.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", description: "item id or title" },
        platform: { type: "string", enum: ["craigslist", "facebook", "nextdoor"], description: "platform it sold on (optional)" },
        price: { type: "number", description: "final sale price (optional)" },
      },
      required: ["item"],
    },
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
    name: "get_weather",
    description:
      "Today's weather for an address, from the US National Weather Service (free, no metered search). Returns the current/next forecast period: conditions, temperature, and precip chance. Use this for the morning digest's per-destination weather instead of web search. The standing locations are in the house rules. US only.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Address or place to get weather for (e.g. a work or drop-off destination)." },
      },
      required: ["location"],
    },
  },
  {
    name: "list_printers",
    description: "List the printers available to Lloyd's host (the Mac mini) and the default one. Use before printing if unsure which printer to target.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "print_document",
    description: "Print a local file on the home printer via the Mac mini (CUPS). `file` must be a path on Lloyd's host (e.g. an image saved under data/). Optional `printer` (name) and `copies`. Local only -- nothing leaves the house. Pairs with image generation (generate then print).",
    input_schema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the file to print, on Lloyd's host." },
        printer: { type: "string", description: "Printer name; omit for the system default." },
        copies: { type: "number" },
      },
      required: ["file"],
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
  {
    name: "find_food_order",
    description:
      "READ-ONLY: look up past food-delivery orders (DoorDash / Postmates). Use for 'find our last order from <restaurant>'. Returns matching past orders (restaurant, items, date, total), newest first. Does not order anything and needs no approval.",
    input_schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "doordash or postmates (optional; omit to search all)" },
        restaurant: { type: "string", description: "restaurant name to filter to (optional)" },
      },
    },
  },
  {
    name: "order_food",
    description:
      "HIGH-STAKES: reorder a past food-delivery order for home delivery. Spends money, so it always requires owner approval first. Use for 'order what we had last time from <restaurant>' or 'order me dinner'. It reconstructs the most recent (or chosen) past order from that restaurant and places it only after approval.",
    input_schema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "doordash or postmates (optional; omit to search all)" },
        restaurant: { type: "string", description: "restaurant to reorder from" },
        which: { type: "string", description: "'last' (default) for the most recent order, or a number N for the Nth most recent" },
        address: { type: "string", description: "delivery address; defaults to home" },
      },
      required: ["restaurant"],
    },
  },
  {
    name: "plan_rx_sync",
    description:
      "Plan a synced monthly CVS prescription delivery. Given each regular med's next ready date and its return-to-stock deadline, it picks ONE delivery date, says which early refills to hold until then, and flags any that can't wait (would be returned to stock first). PLANNING ONLY — it surfaces the plan; it does not contact CVS, change a fill, or order anything. Use when the family wants to consolidate refills onto one monthly delivery.",
    input_schema: {
      type: "object",
      properties: {
        meds: {
          type: "array",
          description: "The regular medications to sync onto one delivery.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              readyDate: { type: "string", description: "YYYY-MM-DD — when the next fill is ready to ship" },
              returnByDate: { type: "string", description: "YYYY-MM-DD — last day before CVS returns it to stock (optional)" },
            },
            required: ["name", "readyDate"],
          },
        },
      },
      required: ["meds"],
    },
  },
];

// Executors for the gated actions, keyed by the `kind` staged in confirm.js. They
// run ONLY when an approval is confirmed (the YES reply or a Slack Approve tap),
// possibly in a different process than the one that staged it (restart-safe), so
// they take serializable params, not closures. Registered once at module load.
registerActionHandler("calendar", async (input) => {
  const r = await createEvent(input);
  await logAction("calendar", `Created event "${r.subject}"${input.start ? ` at ${input.start}` : ""}`);
  return `Event created: ${r.subject}${r.webLink ? ` (${r.webLink})` : ""}`;
});
registerActionHandler("reservation", async ({ platform, url, restaurant, date, partySize, time, type }) => {
  const book = platform === "opentable" ? openTableBook : resyBook;
  const r = await book({ url, date, partySize, time, type });
  await logAction("reservation", `${r.booked ? "Booked" : "Attempted"} ${restaurant || r.venue} ${date} ${time}${type ? ` (${type})` : ""} for ${partySize} (${platform})`);
  return r.booked
    ? `Booked: ${restaurant || r.venue}, ${date} at ${time}${type ? ` (${type})` : ""}, party of ${partySize}. ${r.note || ""}`.trim()
    : `Couldn't book that: ${r.note}`;
});

// Resolve a restaurant (name or a resy/opentable URL) to { url, platform }. A name
// goes through web search; the first hit that is a real VENUE page (not a category
// list) wins. Returns null if nothing bookable is found.
async function resolveReservationVenue(restaurant) {
  const s = String(restaurant || "").trim();
  const direct = venuePlatform(s);
  if (direct) return { url: s, platform: direct };
  const hits = await webSearch(`${s} reservation resy OR opentable`, { count: 10 }).catch(() => []);
  for (const h of Array.isArray(hits) ? hits : []) {
    const p = venuePlatform(h?.url || "");
    if (p) return { url: h.url, platform: p };
  }
  return null;
}
// Auto-pull a sold downsizing item off the platforms it is still live on. Gated
// because it modifies/removes public content. Best-effort per platform: opens the
// listing's manage page (stops before the irreversible confirm) and reports a link
// for Nic to finish the removal; records each as pulled locally.
registerActionHandler("listing_pull", async ({ id, title, platforms }) => {
  const item = await downsizing.getItem(id || title);
  if (!item) throw new Error(`no downsizing item matching "${id || title}"`);
  const results = [];
  for (const platform of platforms || []) {
    try {
      const r = await pullListing({ platform, item });
      await downsizing.markPulled(item.id, platform);
      results.push(`${PLATFORM_LABEL[platform]}: marked pulled${r.manageUrl ? ` (finish removal: ${r.manageUrl})` : ""}`);
    } catch (e) {
      results.push(`${PLATFORM_LABEL[platform]}: could not open (${e.message})`);
    }
  }
  await logAction("listing_pull", `Pulled "${item.title}" from ${(platforms || []).join(", ")}`);
  return `Pulled "${item.title}":\n${results.join("\n")}`;
});
registerActionHandler("calendar_delete", async ({ refs, subject, start }) => {
  const { deleted, errors } = await deleteEvent({ refs });
  await logAction("calendar", `Deleted event "${subject}"${start ? ` at ${start}` : ""} (${deleted.length} calendar${deleted.length === 1 ? "" : "s"})`);
  if (errors.length && !deleted.length) throw new Error(`could not delete "${subject}": ${errors[0].reason}`);
  const partial = errors.length ? ` (${errors.length} ref failed)` : "";
  return `Deleted "${subject}" from ${deleted.length} calendar${deleted.length === 1 ? "" : "s"}${partial}.`;
});
registerActionHandler("email", async ({ to, cc, bcc, subject, body }) => {
  await sendMail({ to, cc, bcc, subject, body }); // the confirmation IS the gate (work domains flagged at stage time)
  await recordEmailContact(to); // remember we've now written them, so next time isn't "first contact"
  await logAction("email", `Sent email to ${to}${subject ? ` re: "${subject}"` : ""}`);
  return "Email sent.";
});
registerActionHandler("order", async ({ url, steps }) => {
  const r = await runOrder({ url, steps }); // guard inside blocks read-only domains
  await logAction("order", `Ran order flow at ${r.finalUrl}`);
  return `Order flow ran. Final URL: ${r.finalUrl}\nSteps: ${r.transcript.join(", ")}`;
});
// Food delivery reorder (workstream T). Runs on Lloyd's local Mac (real IP, signed-in
// Chrome profile) only after the family approves; placeFoodOrder handles the checkout
// (live steps pending -> reports for manual placement until captured). Params are the
// serialized past order (restaurant/items/total/url/provider/address), so it is
// restart-safe like the other gated executors.
registerActionHandler("food_order", async (order) => {
  const r = await placeFoodOrder(order);
  await logAction("order", `Food delivery: ${order?.restaurant || "?"} via ${order?.provider || "?"}`);
  return r;
});
// The weekly Ralphs grocery order (assembled Friday from the shopping list). Runs
// on Lloyd's local Mac (real IP) only after the family approves; placeRalphsOrder
// handles the slow, signed-in-Chrome checkout (live steps pending).
registerActionHandler("grocery", async (order) => {
  const r = await placeRalphsOrder(order);
  await logAction("order", `Ralphs grocery order (${order?.count ?? "?"} items, ${order?.deliveryWindow || "Friday"})`);
  return r;
});
// COO request seam (workstream S step 2). A COO cannot act; it emits requests that
// land here behind the gate. Both record on approval rather than driving any
// automated effect: a heavy lift is something Nic runs himself in a Claude Code
// session (never an agent on the subscription, per the Q reversal), and a coo_action
// is an outbound/spend a HUMAN executes (constraint #3). We log the decision + audit
// the approval so there is a durable record; nothing is auto-sent.
registerActionHandler("heavy_lift", async ({ coo, company, brief, why }) => {
  await logDecision("chief-of-staff", {
    title: `Heavy lift accepted (${company || coo})`,
    decision: brief,
    rationale: why,
    context: "Approved by Nic to run himself in a human-driven Claude Code session; not an automated agent.",
  });
  await logAction("heavy_lift", `Heavy lift accepted for ${company || coo}: ${brief}`);
  return `Logged as an accepted heavy-lift task for you to run: ${brief}`;
});
registerActionHandler("coo_action", async ({ coo, company, action, detail }) => {
  await logDecision("chief-of-staff", {
    title: `Action approved (${company || coo})`,
    decision: action,
    context: detail,
  });
  await logAction("coo_action", `Approved COO action for ${company || coo}: ${action}`);
  return `Approved and logged for a human to execute: ${action}`;
});

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

// Tier 1 voice: when the family sends a voice note, speak Lloyd's answer back on the
// SAME channel (voice in -> voice out). Additive to the text reply, best-effort, and
// gated: only on a voice-note turn, only when TTS is configured, and off if
// COS_VOICE_REPLY=false. iMessage + email carry audio today; Slack audio is a
// fast-follow (its text reply still lands). Never throws to the caller.
export async function maybeVoiceReply(msg, text, { hadVoiceNote = false, deps = {} } = {}) {
  if (!hadVoiceNote) return false;
  if (String(process.env.COS_VOICE_REPLY ?? "true").toLowerCase() === "false") return false;
  const { synth = synthesizeSpeech, imessageAudio = sendImessageAudio, voiceMail = sendVoiceMail, configured = ttsConfigured } = deps;
  if (!configured()) return false;
  const audio = await synth(text);
  if (!audio) return false;
  const target = msg.replyTo || msg.from;
  try {
    if (msg.channel === "imessage") {
      await imessageAudio(target, { bytes: audio.bytes, filename: "lloyd.mp3", contentType: audio.contentType });
    } else if (msg.channel === "email") {
      await voiceMail({ to: target, subject: replySubject(msg.subject), audio: { bytes: audio.bytes, filename: "lloyd-reply.mp3", contentType: audio.contentType }, body: "Voice reply from Lloyd is attached." });
    } else {
      return false; // slack/other: text reply already delivered; audio deferred
    }
    log.info("voice reply sent", { channel: msg.channel });
    return true;
  } catch (err) {
    log.warn("voice reply failed (text reply already delivered)", { channel: msg.channel, reason: String(err?.message || err) });
    return false;
  }
}

// deps injectable for tests; default to the real channel functions.
export function transportFor(msg, { onSms = sendImessage, onMail = sendMail, onReply = replyToMessage, onImessage = sendImessage } = {}) {
  if (msg.channel === "imessage") {
    // replyTo carries the BlueBubbles chatGuid so the reply lands in the exact
    // existing thread (incl. group chats); fall back to the raw handle for a 1:1.
    return { reply: (text) => onImessage(msg.replyTo || msg.from, text), mirror: noop };
  }
  if (msg.channel === "sms") {
    // Twilio is retired; any legacy sms-channel reply goes out over iMessage to
    // the same handle (the number is the same). No Twilio dependency remains.
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
export function wrapDelegateWithMirror(delegateFn, { onDelegate, images, fulfill } = {}) {
  return async ({ agent, task }) => {
    await onDelegate?.({ phase: "start", from: "Lloyd", agent, task });
    const res = await delegateFn({ agent, task, images });
    // Contract is {text, requests} (workstream S step 2); tolerate a bare string.
    const text = typeof res === "string" ? res : res?.text ?? "";
    const requests = res && typeof res === "object" && Array.isArray(res.requests) ? res.requests : [];
    // A COO emits requests; Lloyd fulfills them behind his gate and folds the
    // summary into the tool result the model sees. Specialists return no requests.
    let out = text;
    if (requests.length && fulfill) {
      const summary = await fulfill(agent, requests);
      if (summary) out = text ? `${text}\n\n${summary}` : summary;
    }
    await onDelegate?.({ phase: "result", from: "Lloyd", agent, task, result: out });
    return out;
  };
}

// 011: would this proposed event overlap an existing one? Free/closure events never
// conflict; a date too far out to fetch (>120d) is treated as "gate to be safe".
async function calendarWouldConflict(input) {
  const t = Date.parse(String(input.start));
  if (Number.isNaN(t)) return true;
  if (String(input.showAs || "").toLowerCase() === "free") return false;
  const daysOut = Math.ceil((t - Date.now()) / 864e5) + 2;
  if (daysOut > 120) return true;
  const owner = String(GRAPH.calendarWrite || "nic@freyfam.com").split("@")[0];
  const proposed = { subject: input.subject, start: input.start, end: input.end || input.start, showAs: input.showAs, calendars: [owner] };
  const events = await listEvents({ days: Math.max(1, daysOut) });
  return findConflicts([...events, proposed]).some((c) => c.a === proposed || c.b === proposed);
}

function toolHandlers({ images, onDelegate, thread = null, sourceFrom = null } = {}) {
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
    // fulfill: when the target is a COO, route its emitted requests through Lloyd's
    // gate (specialist delegations, heavy-lift asks, gated actions). Only a COO
    // produces requests; for a plain specialist this is never called.
    delegate: wrapDelegateWithMirror(delegate, {
      onDelegate,
      images,
      fulfill: async (agent, requests) => {
        const coo = companyAgent(agent);
        if (coo?.type !== "coo") return "";
        return fulfillCooRequests(coo, requests, { delegate, requestConfirmation });
      },
    }),
    list_calendar: async ({ top, days, back } = {}) => JSON.stringify(await listEvents({ top, days, back })),
    fox_today: async ({ date } = {}) =>
      JSON.stringify((await getFoxToday(date)) || { note: "no Woodbury Preschool context captured for that day yet" }),
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
      // 011: auto-create routine, family-own events (personal blocks or family-only
      // invitees requested by family, no conflict); gate everything else exactly as
      // before. Conservative: any error -> treat as conflict -> gate.
      let hasConflict = true;
      try { hasConflict = await calendarWouldConflict(input); } catch { hasConflict = true; }
      const gate = calendarGateDecision({ start: input.start, attendees: input.attendees, sourceFrom, hasConflict });
      if (gate.auto) {
        try {
          await createEvent(input);
          log.info("calendar auto-created (011)", { subject: input.subject, why: gate.why });
          return `Added "${input.subject}" (${when})${(input.attendees || []).length ? `, invitees: ${who}` : ""} to the calendar automatically (${gate.why}). Tell me if you want it changed or removed.`;
        } catch (e) {
          log.error("calendar auto-create failed; falling back to approval", { reason: e.message });
        }
      }
      const { instruction } = await requestConfirmation(
        `Create event: ${input.subject}\n${when}\nInvitees: ${who}${input.showAs ? `\nShow as: ${input.showAs}` : ""}`,
        "calendar",
        input,
        { thread }
      );
      return `Ready to create "${input.subject}" (${when}), invitees: ${who}. ${instruction}`;
    },
    delete_calendar_event: async ({ refs, subject, start }) => {
      const list = (Array.isArray(refs) ? refs : []).filter((r) => r && r.calendar && r.id);
      if (!list.length) return `I couldn't delete that — I need the event's refs from list_calendar. Let me look it up first.`;
      const when = start ? ` (${start})` : "";
      const { instruction } = await requestConfirmation(
        `Delete event: ${subject}${when}\nRemoves it from ${list.length} calendar${list.length === 1 ? "" : "s"} and notifies any attendees.`,
        "calendar_delete",
        { refs: list, subject, start },
        { thread }
      );
      return `Ready to delete "${subject}"${when}. ${instruction}`;
    },
    draft_email: async ({ account, to, cc, subject, body, bcc }) => {
      // Draft-only: saved into the family member's OWN Drafts folder, NEVER sent.
      // The human hitting send IS the gate, so no confirmation here. No Lloyd
      // signature: this is the person's own email to send as themselves.
      const who = String(account || "nic").toLowerCase() === "shelli" ? "shelli" : "nic";
      try {
        const { mailbox } = await createDraft({ account: who, to, cc, bcc, subject, body });
        const copies = [cc ? `cc ${cc}` : "", bcc ? `bcc ${bcc}` : ""].filter(Boolean).join(", ");
        return `Saved a draft in ${mailbox}'s Drafts folder — to ${to}${copies ? ` (${copies})` : ""}, subject "${subject}". Not sent; open your Drafts to review and send it yourself.`;
      } catch (e) {
        return `Couldn't save the draft: ${e.message}`;
      }
    },
    send_email: async ({ to, cc, subject, body, bcc }) => {
      // Flag if ANY recipient (to/cc/bcc) is on a work domain. Split first so a
      // comma-separated string is classified per-address, not as one blob.
      const split = (v) => String(v ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      const flag = isWorkDomain([...split(to), ...split(cc), ...split(bcc)]) ? " [WORK DOMAIN]" : "";
      // Append Lloyd's signature so every outbound email is signed consistently
      // (he's told not to add his own sign-off). Stored on the staged action so
      // the approved send matches the preview.
      const signed = `${String(body).trimEnd()}\n\n${GRAPH.signature}`;
      // Show cc/bcc in the approval preview so the owner sees exactly who is copied.
      const ccLine = cc ? `\nCc: ${cc}` : "";
      const bccLine = bcc ? `\nBcc: ${bcc}` : "";
      const { instruction } = await requestConfirmation(
        `Email to ${to}${ccLine}${bccLine}${flag}\nSubject: ${subject}\n${signed.slice(0, 220)}`,
        "email",
        { to, cc, bcc, subject, body: signed },
        { thread }
      );
      const copies = [cc ? `cc ${cc}` : "", bcc ? `bcc ${bcc}` : ""].filter(Boolean).join(", ");
      return `Ready to email ${to}${copies ? ` (${copies})` : ""}${flag} (subject: ${subject}). ${instruction}`;
    },
    fetch_document: async ({ url }) => {
      const { blocks, summaries, skipped } = await fetchDocument(url);
      if (!blocks.length) return `Could not read document: ${skipped?.[0]?.reason || "unsupported type"}`;
      return JSON.stringify({ summary: summaries.join("; "), text: blocks.map((b) => b.text).join("\n\n") });
    },
    browse_and_report: async ({ url }) => {
      try {
        return JSON.stringify(await readPageHeaded(url));
      } catch (e) {
        return `Could not open that page: ${e.message}`;
      }
    },
    browse_page: async ({ url, maxChars }) => {
      try {
        return JSON.stringify(await readPage(url, { maxChars }));
      } catch (e) {
        return `Could not read page: ${e.message}`;
      }
    },
    find_reservation: async ({ restaurant, date, time, partySize = 2 } = {}) => {
      try {
        const v = await resolveReservationVenue(restaurant);
        if (!v) return `I couldn't find "${restaurant}" on Resy or OpenTable. Send me the resy.com or opentable.com venue URL and I'll check it.`;
        const avail = v.platform === "opentable" ? openTableAvailability : resyAvailability;
        const r = await avail({ url: v.url, date, partySize, time });
        const site = v.platform === "opentable" ? "OpenTable" : "Resy";
        if (r.loginWall) return `${site} isn't signed in on my browser profile yet — a one-time login is needed before I can read availability.`;
        const slots = slotsNear(r.slots, time || null);
        if (!slots.length) return JSON.stringify({ venue: r.venue, platform: v.platform, date, partySize, url: r.url, slots: [], note: "No availability for that date and party size." });
        return JSON.stringify({ venue: r.venue, platform: v.platform, date, partySize, url: r.url, slots: slots.slice(0, 12).map((s) => ({ time: s.time, types: s.types })) });
      } catch (e) {
        return `Could not check reservations: ${e.message}`;
      }
    },
    make_reservation: async ({ restaurant, date, time, partySize = 2 } = {}) => {
      try {
        const v = await resolveReservationVenue(restaurant);
        if (!v) return `I couldn't find "${restaurant}" on Resy or OpenTable. Send me the venue URL and I'll set it up.`;
        const site = v.platform === "opentable" ? "OpenTable" : "Resy";
        const avail = v.platform === "opentable" ? openTableAvailability : resyAvailability;
        const r = await avail({ url: v.url, date, partySize, time });
        if (r.loginWall) return `${site} isn't signed in on my browser profile yet — a one-time login is needed before I can book.`;
        const near = slotsNear(r.slots, time);
        if (!near.length) {
          const open = slotsNear(r.slots, null).slice(0, 6).map((s) => s.time).join(", ");
          return `No table at ${r.venue} near ${time} on ${date} for ${partySize}.${open ? ` Open times: ${open}.` : ""}`;
        }
        const pick = near[0];
        const type = pick.types?.[0] || null;
        const { instruction } = await requestConfirmation(
          `Book ${r.venue} (${site}): ${date} at ${pick.time}${type ? ` (${type})` : ""}, party of ${partySize}`,
          "reservation",
          { platform: v.platform, url: r.url, restaurant: r.venue, date, partySize, time: pick.time, type },
          { thread }
        );
        const exact = minutesOfDay(pick.time) === minutesOfDay(time);
        return `${r.venue} (${site}): ${exact ? `${pick.time} is open` : `nearest to ${time} is ${pick.time}`}${type ? ` (${type})` : ""} for ${partySize} on ${date}. ${instruction}`;
      } catch (e) {
        return `Could not set up the reservation: ${e.message}`;
      }
    },
    add_listing_item: async (input = {}) => {
      try {
        const item = await downsizing.addItem(input, { images: images || [] });
        const enabled = downsizing.PLATFORMS.filter((p) => item.platforms[p].status !== "n/a");
        return `Added [${item.id}] "${item.title}"${item.priceAsk != null ? ` at $${item.priceAsk}` : ""} with ${item.photos.length} photo(s), for ${enabled.map((p) => PLATFORM_LABEL[p]).join(", ")}. Say "post it" and tell me which platform to auto-fill, or I can start with Facebook Marketplace.`;
      } catch (e) {
        return `Could not add the item: ${e.message}`;
      }
    },
    list_downsizing: async ({ status } = {}) => {
      try {
        const items = await downsizing.listItems(status ? { status } : {});
        const c = await downsizing.summary();
        return `${downsizing.formatItems(items)}\n\nTotals: ${c.active} active, ${c.draft} draft, ${c.sold} sold${c.soldValue ? ` ($${c.soldValue} taken in)` : ""}, ${c.pulled} pulled.`;
      } catch (e) {
        return `Could not read the downsizing list: ${e.message}`;
      }
    },
    update_listing_item: async ({ item, platform, platformStatus, platformUrl, ...patch } = {}) => {
      try {
        let updated;
        const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
        if (Object.keys(fields).length) updated = await downsizing.updateItem(item, fields);
        if (platform && (platformStatus || platformUrl !== undefined)) {
          updated = await downsizing.setPlatformStatus(item, platform, { status: platformStatus, url: platformUrl });
          if (platformStatus === "listed") await logAction("listing", `Recorded "${updated.title}" live on ${platform}${platformUrl ? ` (${platformUrl})` : ""}`);
        }
        if (!updated) updated = await downsizing.getItem(item);
        return `Updated: ${downsizing.formatItem(updated)}`;
      } catch (e) {
        return `Could not update the item: ${e.message}`;
      }
    },
    post_listing: async ({ item, platform } = {}) => {
      try {
        const it = await downsizing.getItem(item);
        if (!it) return `No downsizing item matching "${item}".`;
        const r = await postListing({ platform, item: it });
        if (!r.filled) {
          return `${PLATFORM_LABEL[platform]} needs a one-time sign-in on my browser profile before I can auto-fill (couldn't fill: ${r.unfilled.join(", ")}). Once signed in I'll fill it and send you the link to post.`;
        }
        await downsizing.setPlatformStatus(it.id, platform, { status: "draft" });
        const gaps = r.unfilled.length ? ` A few fields need your touch: ${r.unfilled.join(", ")}.` : "";
        return `Auto-filled "${it.title}" on ${PLATFORM_LABEL[platform]} (photos${it.photos.length ? " uploaded" : ": none yet"}). I stopped before posting so you can review and hit Post.${gaps}\nFinish + post here: ${r.resumeUrl}\nAfter it's live, send me the link and I'll track it.`;
      } catch (e) {
        return `Could not auto-fill that listing: ${e.message}`;
      }
    },
    price_item: async ({ item, title, description, condition, category, apply } = {}) => {
      try {
        const it = item ? await downsizing.getItem(item) : null;
        const name = title || it?.title;
        if (!name) return "Tell me what to price: an item id/title from the list, or a short description.";
        const desc = description || it?.description || "";
        const cond = condition || it?.condition || "";
        const cat = category || it?.category || "";
        // Comps: general marketplace listings + eBay sold prices (Shey's usual signals).
        const [live, sold] = await Promise.all([
          webSearch(`${name} ${cat} used for sale price`, { count: 6 }).catch(() => []),
          webSearch(`${name} sold price ebay`, { count: 6 }).catch(() => []),
        ]);
        const comps = [...(live || []), ...(sold || [])].slice(0, 10)
          .map((h) => `- ${h.title}: ${h.snippet || ""} (${h.url})`).join("\n") || "(no comps found)";
        const task =
          `Price a used item for a QUICK local sale — the family is moving in ~2 weeks, so lean toward moving it fast, not top dollar. ` +
          `Item: "${name}"${cond ? `, condition ${cond}` : ""}${cat ? `, category ${cat}` : ""}.${desc ? ` Details: ${desc}.` : ""}\n\n` +
          `Comparable listings / sold prices:\n${comps}\n\n` +
          `Reply in exactly three short lines: "Asking: $N", "Range: $low-$high", and one line of rationale (what the comps show + the quick-sale adjustment).`;
        let rec = "";
        try { rec = await delegate({ agent: "resale", task }); } catch { rec = ""; }
        if (!rec || !rec.trim()) {
          return `Shey couldn't be reached to price "${name}", but here are the comps I found so you can set a price:\n${comps}`;
        }
        let applied = "";
        if (apply && it) {
          const m = rec.match(/asking[^$]*\$\s?([\d,]+)/i) || rec.match(/\$\s?([\d,]+)/);
          const price = m ? Number(m[1].replace(/,/g, "")) : NaN;
          if (price > 0) { await downsizing.updateItem(it.id, { priceAsk: price }); applied = `\n\nSaved $${price} as the asking price on [${it.id}].`; }
        }
        return `Shey's pricing for "${name}":\n${rec.trim()}${applied}`;
      } catch (e) {
        return `Could not price that: ${e.message}`;
      }
    },
    mark_item_sold: async ({ item, platform, price } = {}) => {
      try {
        const { item: it, toPull } = await downsizing.markSold(item, { platform, price });
        await logAction("listing", `Marked "${it.title}" sold${platform ? ` on ${platform}` : ""}${price != null ? ` for $${price}` : ""}`);
        if (!toPull.length) return `Marked "${it.title}" sold${price != null ? ` for $${price}` : ""}. It wasn't live anywhere else, so nothing to pull.`;
        const { instruction } = await requestConfirmation(
          `Pull "${it.title}" (sold) off ${toPull.map((p) => PLATFORM_LABEL[p]).join(" + ")}`,
          "listing_pull",
          { id: it.id, title: it.title, platforms: toPull },
          { thread }
        );
        return `Marked "${it.title}" sold${price != null ? ` for $${price}` : ""}. It is still live on ${toPull.map((p) => PLATFORM_LABEL[p]).join(", ")} — pull it everywhere? ${instruction}`;
      } catch (e) {
        return `Could not mark it sold: ${e.message}`;
      }
    },
    amazon_orders: async ({ pages, maxOrders } = {}) => {
      try {
        const res = await fetchAmazonOrders({ pages, maxOrders });
        if (res.signedIn && res.orders?.length) res.needsSummary = summarizeNeeds(res.orders);
        return JSON.stringify(res);
      } catch (e) {
        return `Could not read Amazon orders: ${e.message}`;
      }
    },
    budget_status: async () => {
      try {
        return formatBudget(await budgetStatus());
      } catch (e) {
        return `Could not read budget status: ${e.message}`;
      }
    },
    budget_chart: async () => {
      const s = await budgetStatus();
      if (!s.incomeSet) return formatBudget(s); // nothing to chart until income is set
      const summary = formatBudget(s);
      try {
        const png = await renderBudgetChartPng(budgetChartSvg(s));
        await sendMailWithAttachment({
          to: BUDGET.emailTo,
          subject: `Budget burn — ${s.ym} (day ${s.day}/${s.daysInMonth}), ${s.pctOfIncome}% of income`,
          body: summary,
          attachment: { bytes: png, filename: `budget-${s.ym}.png`, contentType: "image/png" },
        });
        return `Sent the budget-burn chart to the owner.\n${summary}`;
      } catch (e) {
        return `Couldn't render/email the chart (${e.message}); here's the summary:\n${summary}`;
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
    plan_rx_sync: async ({ meds }) => formatRxPlan(planRxSync(meds)),
    add_task: async ({ title, dueDate, owner }) => {
      try {
        const t = await addTask({ title, dueDate, owner });
        if (t.deduped) {
          return t.status === "done"
            ? `Already handled (marked done ${t.completedAt ? t.completedAt.slice(0, 10) : "recently"}) — not re-adding "${t.title}". Do NOT surface this as open or overdue.`
            : `Already on the list: "${t.title}"${t.dueDate ? ` (due ${t.dueDate})` : ""} {${t.id}} — not duplicating.`;
        }
        return `Added task: "${t.title}"${t.dueDate ? ` (due ${t.dueDate})` : ""}${t.owner ? ` for ${t.owner}` : ""} {${t.id}}`;
      } catch (e) {
        return `Could not add task: ${e.message}`;
      }
    },
    list_tasks: async ({ includeDone } = {}) => formatTasks(await listTasks({ includeDone })),
    list_receipts: async ({ sinceDays, kind } = {}) => formatReceipts(await listReceipts({ sinceDays, kind })),
    order_playbook: async ({ store } = {}) => {
      const s = String(store || "").toLowerCase();
      if (s === "ralphs") {
        const items = await gatherGroceryItems({ store: "Ralphs", local: await listShopping() });
        return items.length ? `${items.length} items from the Ralphs list.\n\n${buildGroceryPlaybook({ store: "ralphs", phase: "fill", items, applyFuelCoupon: true })}` : "The Ralphs list is empty — nothing to order.";
      }
      if (s === "costco") {
        const items = await gatherGroceryItems({ store: "Costco" });
        return items.length ? `${items.length} items from the Costco list.\n\n${buildGroceryPlaybook({ store: "costco", phase: "fill", items })}` : "The Costco list is empty — nothing to order.";
      }
      if (s === "cvs") {
        const items = await gatherGroceryItems({ store: "CVS" });
        return items.length ? `${items.length} items from the CVS list.\n\n${buildCvsOtcPlaybook({ phase: "fill", items })}` : "The CVS list is empty — nothing to order.";
      }
      return "Unknown store — use ralphs, costco, or cvs.";
    },
    complete_task: async ({ task }) => {
      const t = await completeTask(task);
      return t ? `Marked done: "${t.title}"` : "No single matching open task — that phrase matched none or more than one. Call list_tasks and complete by the {id}, or be more specific.";
    },
    dismiss_alert: async ({ topic }) => {
      const r = await dismissAlert(String(topic || ""));
      return r.ok ? `Got it — I won't flag that again.` : "That topic's too vague to dismiss safely; add its distinctive words (e.g. the merchant/subject).";
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
    dismiss_resale_listing: async ({ urls } = {}) => {
      const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
      if (!list.length) return "No listing URL found to dismiss.";
      const added = await dismissBoutiqueListings(list);
      if (!added.length) return "Those listings were already dismissed. You won't see them again.";
      return `Got it. I won't show ${added.length === 1 ? "that listing" : `those ${added.length} listings`} again.`;
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
    read_store_list: async ({ store }) => {
      try {
        const items = await listTodoTasks(store);
        return items.length ? `${store} list (${items.length}):\n${items.map((i) => `- ${i.title}`).join("\n")}` : `The ${store} list is empty.`;
      } catch (e) {
        return `Could not read the ${store} list: ${e.message}`;
      }
    },
    add_to_store_list: async ({ store, item }) => {
      try {
        const t = await addTodoTask(store, item);
        return `Added "${t.title}" to the ${store} list.`;
      } catch (e) {
        return `Could not add to the ${store} list: ${e.message}`;
      }
    },
    meals_to_grocery_list: async ({ startDate, endDate, store }) => {
      try {
        const meals = await getMealsInRange(startDate, endDate);
        const items = mealsToGroceryItems(meals);
        if (!items.length) return "None of those meals have ingredients listed, so there's nothing to add. (Add ingredients when planning a meal to use this.)";
        const target = store || "Ralphs";
        for (const it of items) await addTodoTask(target, it);
        await logAction("list", `Added ${items.length} meal ingredient(s) to the ${target} list`);
        return `Added ${items.length} ingredient(s) from ${meals.length} meal(s) to the ${target} list: ${items.slice(0, 15).join(", ")}${items.length > 15 ? "…" : ""}`;
      } catch (e) {
        return `Could not build the grocery list: ${e.message}`;
      }
    },
    recent_actions: async ({ days } = {}) => formatAudit(await listActions({ sinceDays: days || 7 })),
    show_today: async () => {
      const tz = process.env.FAMILY_TZ || "America/Los_Angeles";
      const now = new Date();
      const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const dateLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(now);
      const nowLabel = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);
      const nowHM = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now); // "18:52", for past/upcoming compare
      const safe = async (fn, fb) => { try { return await fn(); } catch { return fb; } };
      const rawEvents = (await safe(() => listEvents({ days: 1 }), [])) || [];
      const events = rawEvents.slice(0, 8).map((e) => ({
        time: String(e.start?.dateTime || e.start || "").slice(11, 16),
        title: e.subject || e.title || "(event)",
        who: Array.isArray(e.calendars) ? e.calendars.join("/") : e.calendars || "",
      }));
      const foxRaw = await safe(() => getFoxToday(), null);
      const fox = foxRaw ? { activities: foxRaw.activities || "", wardrobe: foxRaw.clothingHint || "" } : null;
      const meals = (await safe(() => getMealsInRange(todayKey, todayKey), [])) || [];
      const pkgs = (await safe(() => listActivePackages(), [])) || [];
      const packages = pkgs.map((p) => ({ label: p.label || p.carrier, carrier: p.carrier, eta: p.eta || p.status }));
      const taskList = (await safe(() => listTasks(), [])) || [];
      const tasks = taskList
        .filter((t) => !t.done && t.dueDate)
        .map((t) => ({ title: t.title, overdue: t.dueDate < todayKey }))
        .filter((t) => t.overdue || taskList.find((x) => x.title === t.title)?.dueDate === todayKey);
      return formatDashboard({ dateLabel, nowLabel, nowHM, events, fox, meals, packages, tasks });
    },
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
    get_weather: async ({ location }) => {
      try {
        const w = await getWeather(location);
        return `${location}: ${formatWeather(w)}`;
      } catch (e) {
        return `Could not get weather: ${e.message}`;
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
    list_printers: async () => JSON.stringify(await listPrinters()),
    print_document: async ({ file, printer, copies } = {}) => {
      const r = await printDocument(file, { printer, copies });
      if (r.ok) {
        await logAction("print", `Printed ${file} on ${r.printer}${copies && copies > 1 ? ` x${copies}` : ""}`);
      }
      return r.message;
    },
    place_order: async ({ url, summary, steps }) => {
      const { instruction } = await requestConfirmation(
        `Place order via browser:\n${summary}\n${url}`,
        "order",
        { url, summary, steps },
        { thread }
      );
      return `Ready to place this order: ${summary}. ${instruction}`;
    },
    find_food_order: async ({ provider, restaurant } = {}) =>
      formatFoodOrders(await findFoodOrders({ provider, restaurant })),
    order_food: async ({ provider, restaurant, which = "last", address = "home" } = {}) => {
      const { order, reason } = await resolveReorder({ provider, restaurant, which });
      if (!order) return reason || "I couldn't find a past order to reorder.";
      const { instruction } = await requestConfirmation(
        `Order dinner:\n${formatReorder(order, { address })}`,
        "food_order",
        { ...order, address },
        { thread }
      );
      return `Ready to place this order from ${order.restaurant}. ${instruction}`;
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

// Memory ids lead with the save-time epoch ms ("1781878812436:xyz"). Render a short
// "(saved Jun 28) " tag so the chief anchors a day-specific recalled fact (a daycare
// schedule, an appointment) to WHEN it was saved rather than assuming it's about today.
function memSavedTag(m) {
  const ms = Number(String(m?.id || "").split(":")[0]);
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Intl.DateTimeFormat("en-US", { timeZone: FAMILY_TZ, month: "short", day: "numeric", year: "numeric" }).format(new Date(ms));
  return `(saved ${d}) `;
}

// Anthropic server-side web search. Resolves inline within a single API call
// (no local handler needed), so the agentLoop just sees the final text. Billed
// per search, so we only attach it when a caller opts in (today: the morning
// digest, for live weather + traffic along each person's commute).
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 6 };

export async function runChief(body, model, { content, images, onDelegate, webSearch, history = [], thread = null, sourceFrom = null } = {}) {
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
    mems.length
      ? `Relevant memory (each tagged with when it was saved; a day-specific fact like a schedule is about THAT date, not necessarily today):\n${mems.map((m) => `- ${memSavedTag(m)}${m.text}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  // Trace each tool the chief calls so a runaway loop (the one that ends in "max
  // tool turns reached") is visible — same wrapper as the specialists. Names only.
  const rawHandlers = toolHandlers({ images, onDelegate, thread, sourceFrom });
  const tracedHandlers = {};
  for (const [name, fn] of Object.entries(rawHandlers)) {
    tracedHandlers[name] = async (input) => {
      log.info("tool call", { agent: "chief", tool: name });
      try {
        return await fn(input);
      } catch (e) {
        log.warn("tool call failed", { agent: "chief", tool: name, error: String(e?.message || e) });
        throw e;
      }
    };
  }
  // Tag each prior turn with WHEN it was said (absolute, family-local, so it's stable
  // across turns and cache-friendly) so the chief anchors "tonight"/"tomorrow" in an
  // old turn to when it was uttered — not to now. Strip the ts field the API rejects.
  const stampedHistory = (history || []).map((m) => ({
    role: m.role,
    content: (m && m.ts && typeof m.content === "string")
      ? `[${new Date(m.ts).toLocaleString("en-US", { timeZone: FAMILY_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}] ${m.content}`
      : (m ? m.content : ""),
  }));
  const { text } = await agentLoop({
    model,
    system: systemBlocks(p, volatile),
    // Prior turns (short-term memory) precede the current one so a follow-up like
    // "Nic's" resolves against "whose haircut?". `content` (text + image blocks)
    // wins for the current turn when an MMS carried photos; else plain text.
    messages: [...stampedHistory, { role: "user", content: content || body }],
    tools: webSearch ? [...tools, WEB_SEARCH_TOOL] : tools,
    toolHandlers: tracedHandlers, // images + delegation mirror, with call tracing
    maxTurns: 12, // image -> search -> delegate flows need more than the default 8
  });
  // Never send the raw loop-cap sentinel to the family. If Lloyd ran out of turns,
  // log it (the trace above shows which tools he looped on) and reply gracefully.
  if (/^\(stopped: max tool turns reached\)/.test(text)) {
    log.warn("chief hit max tool turns", { model });
    return "Sorry, I got tangled up working on that and didn't finish. Let me take another run at it. If it happens again, a quick nudge with any extra detail helps.";
  }
  return text;
}

// Materialize email attachments: inline {bytes|contentBytes} from the front door,
// or fetched from the mailbox via Graph when a graphMessageId is present. Non-fatal.
/**
 * Route collected attachments by kind: IMAGES go to the vision path
 * (fetchInboundMedia), everything else to document extraction (PDF/.ics/.vcf).
 * An emailed/iMessaged photo arrives as a {contentType:"image/...", bytes}
 * attachment, so without this split it would land in extractDocuments and be
 * dropped as "unsupported type" — the bug that made Lloyd/Shey blind to emailed
 * photos. Pure; matched on the declared content type (the bytes are re-sniffed
 * downstream, so a mislabeled image is still corrected by fetchInboundMedia).
 */
export function splitAttachmentsByKind(attachments = []) {
  const isImg = (a) => String(a?.contentType || "").toLowerCase().startsWith("image/");
  // AUDIO (voice notes / voicemails) goes to transcription, not document extraction
  // (an m4a would otherwise land in extractDocuments and be dropped as unsupported).
  const imageAtts = attachments.filter(isImg);
  const audioAtts = attachments.filter((a) => !isImg(a) && isAudioAttachment(a));
  const docAtts = attachments.filter((a) => !isImg(a) && !isAudioAttachment(a));
  return { imageAtts, audioAtts, docAtts };
}

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
  // Authorization (hard constraint #1 + #2). Only an authorized sender may drive
  // the chief OR resolve an approval. Computed once, up front. Silent-capture
  // paths below (OTP relay, shipment/txn filing) deliberately run for UNauthorized
  // service mail too — they never run a model or reply — so this only gates the
  // agent run and the approval gate.
  const authorized = isAuthorizedSender(msg);

  // 0. Is this a YES/NO answer to a pending approval? If so, resolve it (running
  //    the staged action on YES) and reply with the outcome on this same channel.
  //    Approvals are high-stakes: only an AUTHORIZED sender can approve, so an
  //    outsider's "YES <code>" is ignored (it never reaches resolveByCode).
  if (authorized) {
    const confirm = await tryResolveConfirmation(msg.body);
    if (confirm.handled) {
      if (confirm.message) await transport.reply(confirm.message);
      return;
    }
  }

  // 0a. Verification / one-time codes: relay the code to the owner immediately.
  //     Runs BEFORE the auto-reply suppression below, because OTP emails usually
  //     come from no-reply senders that the suppressor (rightly) drops — we still
  //     want the code. Conservative matcher (keyword + 4-8 digit), so low noise.
  //     Skip the family's OWN addresses and our mailbox: real OTPs come from
  //     external services, never from nic@/shelli@/cos@. A keyword+number in
  //     Nic's own mail (e.g. discussing a code) was relaying his "code" back to
  //     him — pure false-positive noise.
  if (msg.channel === "email" && !isFamilyAddress(msg.from) && !isSelfAddress(msg.from)) {
    const code = extractVerificationCode(msg.subject, msg.body);
    if (code) {
      const from = msg.from ? ` (from ${msg.from})` : "";
      await notifyOwner(`Verification code: ${code}${from}`);
      log.info("verification code relayed", { from: msg.from });
      return;
    }
  }

  // 0a2. Vendor/food receipts arriving at the mailbox (Nic auto-forwards these):
  //      capture silently and STOP -- never reject, never reply, no agent run. Fires
  //      for a non-family sender (a standard auto-forward preserves the vendor's From)
  //      OR a family member's "Fwd:" of a receipt (manual/rewritten forward). A
  //      genuine non-forwarded family note still reaches the chief. Runs before the
  //      auth gate; capture is storage-only, so it does not weaken that gate. See
  //      memory vendor-receipts-intake.
  const looksForwarded = /^\s*(fwd?|fw):/i.test(String(msg.subject || ""));
  if (msg.channel === "email" && !isSelfAddress(msg.from) && isReceipt({ subject: msg.subject, body: msg.body }) && (!isFamilyAddress(msg.from) || looksForwarded)) {
    try {
      const row = await captureReceipt({ from: msg.from, subject: msg.subject, body: msg.body, at: msg.receivedAt });
      if (row) log.info("captured vendor receipt", { vendor: row.vendor, total: row.total, kind: row.kind });
    } catch (e) { log.error("receipt capture failed", { reason: e.message }); }
    return;
  }

  // 0b. Never auto-reply to machine senders (bounces, no-reply, marketing) or to
  //     our own mailbox. The email front door enqueues everything in the mailbox,
  //     so this is the chokepoint that stops bounce loops and saves tokens. SMS /
  //     Slack senders never match, so they always pass.
  if (!shouldAutoReply(msg.from)) {
    // Carrier shipping/delivery notices come from no-reply/automated senders, so we
    // won't auto-REPLY. But the tracking number is still worth keeping: record it
    // silently (no outbound) so package tracking works hands-off. Previously these
    // were dropped entirely here, which is why auto-tracking never fired. Idempotent
    // (upsert by tracking number), so the heartbeat scan re-seeing it is harmless.
    if (
      msg.channel === "email" &&
      !isSelfAddress(msg.from) &&
      (isShippingEmail(msg.subject, msg.body) || isDeliveryConfirmation(msg.subject, msg.body))
    ) {
      try {
        const r = await processShipmentEmail({ subject: msg.subject, body: msg.body });
        if (r.tracked.length || r.delivered.length) {
          log.info("auto-tracked shipment (suppressed sender)", { from: msg.from, tracked: r.tracked.length, delivered: r.delivered.length });
        }
      } catch (e) {
        log.error("shipment auto-track failed", { reason: e.message });
      }
    }
    // Bank/card transaction alerts: file silently for the daily finance ingest
    // (no triage, no reply, no model). The daily batch (heartbeat) extracts the
    // queue into the spend log. Same silent-capture pattern as shipment tracking.
    if (
      msg.channel === "email" &&
      !isSelfAddress(msg.from) &&
      isTransactionAlert({ from: msg.from, subject: msg.subject, body: msg.body })
    ) {
      try {
        await queueAlert({ from: msg.from, subject: msg.subject, body: msg.body });
        log.info("queued transaction alert for finance ingest", { from: msg.from });
      } catch (e) {
        log.error("queue transaction alert failed", { reason: e.message });
      }
    }
    log.info("auto-reply suppressed (automated/self sender)", { from: msg.from, channel: msg.channel });
    return;
  }

  // 0c. Authorization gate for the agent run. A human STRANGER (not automated, so
  //     it passed the suppression above) must NOT be able to drive the chief or be
  //     replied to — that was unauthenticated data exfiltration via the public
  //     mailbox. Drop silently: no reply, so Lloyd is not an oracle for outsiders.
  //     OTP relay + shipment/txn capture already ran above for legitimate service
  //     mail, so nothing useful is lost.
  if (!authorized) {
    log.warn("inbound dropped (unauthorized sender)", { from: msg.from, channel: msg.channel });
    return;
  }

  // 1. Gather non-text content (all non-fatal): MMS photos -> Claude image blocks
  //    (vision); email attachments -> document text blocks (PDF/.ics/.vcf). Lloyd
  //    is multimodal here: read a receipt photo or a PDF invoice, then delegate to
  //    Carmine (groceries) / Shey (resale) / Patrick (finance).
  const extraBlocks = [];
  const triageNotes = [];
  let images;

  // Collect attachments first and SPLIT by kind. Email (Graph) and iMessage
  // attachments arrive here as {name, contentType, bytes}; an IMAGE among them must
  // go to the VISION path, not document extraction. Previously every attachment was
  // handed to extractDocuments, which only keeps PDF/.ics/.vcf and dropped images as
  // "unsupported type" — so a photo emailed to Lloyd never reached Shey/Carmine.
  const attachments = await collectAttachments(msg);

  // Chase CSV auto-import: a forwarded "Download account activity" CSV (checking
  // or credit) from a family/self address is ingested straight into the finance
  // log (deduped, non-spend rows dropped) and acknowledged — not run through
  // triage. This is the reliable path for checking, which Chase mostly doesn't
  // alert per-transaction. Only family/self senders, so a stranger can't inject
  // finance rows.
  if (isFamilyAddress(msg.from) || isSelfAddress(msg.from)) {
    const csv = attachments.find((a) => isChaseCsvAttachment(a));
    if (csv) {
      try {
        const r = await ingestChaseCsv(csv.bytes.toString("utf8"));
        await transport.reply(r.summary);
      } catch (e) {
        await transport.reply(`I couldn't import that Chase CSV: ${e.message}`);
      }
      return;
    }
  }

  const { imageAtts, audioAtts, docAtts } = splitAttachmentsByKind(attachments);

  // MMS/Slack media (msg.media) + emailed/iMessage image attachments share ONE vision
  // pass. fetchInboundMedia sniffs the real bytes (and transcodes HEIC), so a
  // mislabeled type is corrected regardless of which channel it came in on.
  const mediaItems = [
    ...(Array.isArray(msg.media) ? msg.media : []),
    ...imageAtts.map((a) => ({ contentType: a.contentType, bytes: a.bytes })),
  ];
  if (mediaItems.length) {
    const { imageBlocks, skipped } = await fetchInboundMedia(mediaItems);
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

  if (docAtts.length) {
    const { blocks, summaries } = await extractDocuments(docAtts);
    extraBlocks.push(...blocks);
    triageNotes.push(...summaries);
  }

  // Voice notes / voicemails (email, Slack, iMessage) -> transcript blocks so the
  // chief reads them like any message. Best-effort; a note that can't be transcribed
  // is surfaced (not silently dropped) so Lloyd can flag it to the sender.
  if (audioAtts.length) {
    const { blocks, summaries, skipped } = await extractAudio(audioAtts);
    extraBlocks.push(...blocks);
    triageNotes.push(...summaries);
    if (skipped.length && !blocks.length) {
      extraBlocks.push({
        type: "text",
        text: `[Note: ${skipped.length} voice note(s) could not be transcribed: ${skipped[0].reason}. Acknowledge to the sender and, if needed, ask them to resend or type it out.]`,
      });
      triageNotes.push(`${skipped.length} untranscribed voice note(s)`);
    }
  }

  // Advisory routing hints (receipt->finance, shipping->track, invite->schedule) so
  // triage AND the chief route common kinds well. Conservative; the model still decides.
  triageNotes.push(...routingHints(msg.subject, msg.body));

  // Fold the notes into BOTH what triage sees (for the model tier) and what the chief
  // sees (for routing/delegation) — the chief picks the specialist, so the hint must
  // reach his content, not just triage.
  const noteText = triageNotes.length ? `\n\n[Context: ${triageNotes.join("; ")}]` : "";
  const bodyText = msg.body?.trim() || "";
  let content;
  if (extraBlocks.length) {
    content = [{ type: "text", text: (bodyText || "(attachment, no message)") + noteText }, ...extraBlocks];
  } else if (noteText) {
    content = [{ type: "text", text: (bodyText || "(no message)") + noteText }];
  }
  const triageText = [msg.body || "", triageNotes.length ? `[${triageNotes.join("; ")}]` : ""].filter((s) => s.trim()).join("\n").trim() || (msg.body || "");

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
    // delegate returns {text, requests} (workstream S step 2). A forced channel is
    // normally a specialist (no requests), but if it is ever a COO, fulfill its
    // requests behind the gate just like the chief's delegate tool does.
    const res = await delegate({ agent: forceAgent, task: foldThread(history, body), images });
    text = typeof res === "string" ? res : res?.text ?? "";
    const reqs = res && Array.isArray(res.requests) ? res.requests : [];
    if (reqs.length) {
      const coo = companyAgent(forceAgent);
      if (coo?.type === "coo") {
        const summary = await fulfillCooRequests(coo, reqs, { delegate, requestConfirmation });
        if (summary) text = text ? `${text}\n\n${summary}` : summary;
      }
    }
  } else {
    const t = await triageInbound(triageText);
    const model = modelForTurn({ channel: msg.channel, complexity: t.complexity, high_stakes: t.high_stakes });
    text = await runChief(msg.body || "(photo message)", model, {
      content,
      images,
      history,
      // Thread approval emails INTO the source conversation when this turn was triggered
      // by an email (else the notifier falls back to a standalone approval email).
      thread: msg.channel === "email" && msg.graphMessageId ? { messageId: msg.graphMessageId, subject: msg.subject } : null,
      sourceFrom: msg.from, // 011: "trusted sender" check for calendar auto-create
      onDelegate: (event) => transport.mirror(event),
    });
  }

  // 4. Deliver via the transport (channel reply for SMS/email; channel post for Slack).
  await transport.reply(text);
  // 4b. Audible reply (Tier 1 voice): if the family SENT a voice note, also speak the
  //     answer back on the same channel. Additive + best-effort — the text reply above
  //     always stands, so a TTS/send failure loses nothing.
  await maybeVoiceReply(msg, text, { hadVoiceNote: audioAtts.length > 0 }).catch(() => {});
  // 5. Record the exchange so the next message from this sender has context.
  await appendTurn(convoKey, triageText || msg.body || "(photo message)", text);
  return text;
}

// Re-export for the heartbeat to escalate actionable items into real runs.
export { recentMailSignals };
