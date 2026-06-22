import "dotenv/config";

// ---------------------------------------------------------------------------
// Model tiers. These are the cost dial. Triage routes DOWN by default; only
// high-stakes or complex work is allowed to escalate to `heavy`.
// Confirm exact model IDs / snapshots at https://docs.claude.com/en/docs/about-claude/models
// ---------------------------------------------------------------------------
export const MODELS = {
  triage: process.env.MODEL_TRIAGE || "claude-haiku-4-5",   // cheap router + heartbeat gate
  standard: process.env.MODEL_STANDARD || "claude-sonnet-4-6", // the workhorse
  heavy: process.env.MODEL_HEAVY || "claude-opus-4-8",      // high-stakes / agentic only
};

// Map a triage complexity verdict to a model tier.
export function modelForComplexity(complexity, highStakes = false) {
  if (highStakes) return MODELS.heavy;
  switch (complexity) {
    case "trivial":  return MODELS.triage;   // Haiku can just answer it
    case "complex":  return MODELS.heavy;
    case "standard":
    default:         return MODELS.standard;
  }
}

export const HEARTBEAT_INTERVAL_MS = Number(
  process.env.HEARTBEAT_INTERVAL_MS || 15 * 60 * 1000 // 15 min
);

// ---------------------------------------------------------------------------
// WORK DOMAINS (policy updated 2026-06-20). No longer a hard block. The family's
// own work addresses may be calendar invitees freely; sending EMAIL to these
// domains is allowed but high-stakes, so it goes through the confirmation gate
// (confirm.js) like any outbound. guards.isWorkDomain() flags these recipients.
// (Env still accepts the old READ_ONLY_DOMAINS name for back-compat.)
// ---------------------------------------------------------------------------
export const WORK_DOMAINS = (
  process.env.WORK_DOMAINS || process.env.READ_ONLY_DOMAINS || "flyerdefense.com,disney.com"
)
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

export const TWILIO = {
  accountSid: process.env.TWILIO_ACCOUNT_SID,
  authToken: process.env.TWILIO_AUTH_TOKEN,
  from: process.env.TWILIO_FROM,                       // e.g. +1818...
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID, // preferred for prod
  owner: process.env.OWNER_PHONE,                      // Nic's number for confirmations
};

export const AZURE = {
  queueConnectionString: process.env.AZURE_STORAGE_CONNECTION_STRING,
  inboundQueue: process.env.INBOUND_QUEUE_NAME || "inbound-messages",
  // Poison messages (failed > MAX_DEQUEUE times) are parked here so they stop
  // cycling and can be inspected/replayed. Derived from the inbound name.
  deadLetterQueue:
    process.env.DEAD_LETTER_QUEUE_NAME ||
    `${process.env.INBOUND_QUEUE_NAME || "inbound-messages"}-poison`,
};

export const GRAPH = {
  tenantId: process.env.GRAPH_TENANT_ID,
  clientId: process.env.GRAPH_CLIENT_ID,
  clientSecret: process.env.GRAPH_CLIENT_SECRET,
  mailbox: process.env.GRAPH_MAILBOX || "cos@freyfam.com", // mail in/out + attachments; assistant@ is an alias
  // Family calendars Lloyd READS and merges (the real schedule lives here, not on
  // cos@). App-only Calendars.ReadWrite reaches any tenant mailbox, so no sharing
  // needed. Comma-separated.
  calendars: (process.env.GRAPH_CALENDARS || "nic@freyfam.com,shelli@freyfam.com")
    .split(",").map((s) => s.trim()).filter(Boolean),
  // Where NEW events are created so they land on the family calendar Lloyd reads.
  calendarWrite: process.env.GRAPH_CALENDAR_WRITE || "nic@freyfam.com",
  // How many days forward the schedule view spans (from start of today, local).
  calendarDays: Number(process.env.GRAPH_CALENDAR_DAYS ?? 7),
};

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Specialist transport (the delegate seam). `delegate` runs each specialist
// either in-process ("local", today's default) or as an isolated Azure Function
// ("remote"). The signature {agent, task} -> text is identical either way, so
// flipping COS_SPECIALIST_MODE is the whole migration switch on Lloyd's side.
//
// Isolation in remote mode comes from each specialist being its OWN Function
// with its own managed identity + Table scope (one endpoint per agent below),
// NOT from keeping compute warm. Functions Consumption = scale-to-zero.
//
// HARD CONSTRAINT: specialists only return text; outbound + confirmation stay on
// Lloyd. Remote mode does not change that - a remote specialist has no channel.
// ---------------------------------------------------------------------------
export const SPECIALISTS = {
  mode: process.env.COS_SPECIALIST_MODE || "local",        // 'local' | 'remote'
  functionKey: process.env.COS_SPECIALIST_KEY,             // fallback key if no per-agent key set
  timeoutMs: Number(process.env.COS_SPECIALIST_TIMEOUT_MS || 30000), // cold start + run budget
  endpoints: {
    finance: process.env.COS_SPECIALIST_URL_FINANCE,
    dev: process.env.COS_SPECIALIST_URL_DEV,
    resale: process.env.COS_SPECIALIST_URL_RESALE,
    chef: process.env.COS_SPECIALIST_URL_CHEF,
    security: process.env.COS_SPECIALIST_URL_SECURITY,
  },
  // Each specialist Function has its OWN function key (isolation), so a leaked
  // key only exposes one specialist. Falls back to functionKey if unset.
  keys: {
    finance: process.env.COS_SPECIALIST_KEY_FINANCE,
    dev: process.env.COS_SPECIALIST_KEY_DEV,
    resale: process.env.COS_SPECIALIST_KEY_RESALE,
    chef: process.env.COS_SPECIALIST_KEY_CHEF,
    security: process.env.COS_SPECIALIST_KEY_SECURITY,
  },
};

// ---------------------------------------------------------------------------
// Cost watchdog. Reads month-to-date spend from the Anthropic Console (Admin
// API) and Azure (Cost Management) on a throttled cadence and texts the owner
// when a billing cycle crosses the threshold. All reads are plain API calls;
// no model tokens. Leave creds unset to disable a given meter. See src/cost.js.
// ---------------------------------------------------------------------------
export const COST = {
  thresholdUsd: Number(process.env.COST_ALERT_USD || 100),     // first alert
  stepUsd: Number(process.env.COST_ALERT_STEP_USD || 50),      // re-alert every +$50 as it climbs
  cycleDay: Number(process.env.COST_CYCLE_DAY || 1),           // day-of-month the billing cycle starts (UTC)
  checkIntervalMs: Number(process.env.COST_CHECK_INTERVAL_MS || 60 * 60 * 1000), // hourly
  statePath: process.env.COST_STATE_PATH || "./data/cost-alerts.json",
  anthropicAdminKey: process.env.ANTHROPIC_ADMIN_KEY,          // sk-ant-admin... (NOT the inference key)
  azure: {
    tenantId: process.env.AZURE_TENANT_ID,
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID,
  },
  // Brave Search has no billing API, so we meter the queries THIS daemon makes
  // (src/search.js) per cycle and convert to overage cost from the plan: anything
  // above includedQueries bills at overageUsdPer1k per 1,000 queries. Meter is off
  // until overageUsdPer1k > 0. Assumes this daemon is the Brave consumer for the
  // key; a key shared with other apps will undercount.
  brave: {
    includedQueries: Number(process.env.BRAVE_INCLUDED_QUERIES || 0),
    overageUsdPer1k: Number(process.env.BRAVE_OVERAGE_USD_PER_1K || 0),
    usagePath: process.env.BRAVE_USAGE_PATH || "./data/brave-usage.json",
    get enabled() { return this.overageUsdPer1k > 0; },
  },
};

// ---------------------------------------------------------------------------
// Slack (the "desk" channel, workstream K). Socket Mode = the Mac opens an
// OUTBOUND websocket; no public endpoint, same pull-only property as the SMS
// queue. Needs an app-level token (xapp-, connections:write) + a bot token
// (xoxb-). Disabled until both are set, so the daemon runs fine without Slack.
// ---------------------------------------------------------------------------
export const SLACK = {
  appToken: process.env.SLACK_APP_TOKEN,   // xapp-... (Socket Mode)
  botToken: process.env.SLACK_BOT_TOKEN,   // xoxb-...
  // Where delegation handoffs + approval buttons are mirrored. Channel id or name.
  commandChannel: process.env.SLACK_COMMAND_CHANNEL || "#command",
  get enabled() {
    return Boolean(this.appToken && this.botToken);
  },
};

// ---------------------------------------------------------------------------
// Morning digest (ported from the legacy assistant). Fires once per local day
// in a morning window; Lloyd composes it by delegating to the specialists.
// ---------------------------------------------------------------------------
export const DIGEST = {
  hour: Number(process.env.DIGEST_HOUR ?? 7),            // local hour to send
  tz: process.env.FAMILY_TZ || "America/Los_Angeles",
  windowHours: Number(process.env.DIGEST_WINDOW_HOURS ?? 2), // catch-up window after `hour`
  enabled: String(process.env.DIGEST_ENABLED ?? "true").toLowerCase() === "true",
  // Email recipients for the digest (reliable now; SMS rides Twilio clearance).
  // Comma-separated; empty disables the email copy.
  emailTo: (process.env.DIGEST_EMAIL_TO || "nic@freyfam.com,shelli@freyfam.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

// Azure Maps: precise commute times with live traffic (geocode + route).
// Ported from the legacy assistant; powers the chief's commute_time tool.
export const MAPS = {
  key: process.env.AZURE_MAPS_KEY || "",
};

// Web search (workstream N). Read-only provider wrapper behind the `search`
// tool. Brave by default; degrades to "unavailable" when no key is set.
export const SEARCH = {
  provider: process.env.SEARCH_PROVIDER || "brave",
  key: process.env.BRAVE_SEARCH_KEY || "",
  count: Number(process.env.SEARCH_RESULT_COUNT ?? 5),
};

// Local semantic embeddings (workstream E). provider "local" runs a small
// sentence-transformer on the Mac via transformers.js; "none" keeps the
// dependency-free lexical recall. Model caches under cacheDir (downloaded once).
export const EMBEDDINGS = {
  provider: process.env.EMBEDDINGS_PROVIDER || "local",
  model: process.env.EMBEDDINGS_MODEL || "Xenova/all-MiniLM-L6-v2",
  cacheDir: process.env.EMBEDDINGS_CACHE_DIR || "./data/models",
};
