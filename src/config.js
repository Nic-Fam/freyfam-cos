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

// ---------------------------------------------------------------------------
// iMessage via a self-hosted BlueBubbles server on the always-on Mac (Lloyd's
// Mac mini). Outbound = POST to the BlueBubbles REST send API; inbound = a
// localhost-only HTTP listener that BlueBubbles webhooks fire on each new
// message. Both halves live on the SAME machine, so iMessage traffic never
// leaves the LAN and never touches Azure/Twilio (those stay the fallback for
// non-Apple recipients: school, vendors). Disabled until serverUrl is set, so
// the daemon runs fine before the mini is provisioned.
//
// allow: optional allowlist of iMessage handles (phones in E.164 and/or Apple
// ID emails) permitted to talk to the chief. Unlike the private Twilio number,
// an Apple ID handle is easy to guess/spam and every inbound costs triage
// tokens, so this gate keeps strangers out. Empty = allow all (parity with SMS).
// ---------------------------------------------------------------------------
export const IMESSAGE = {
  serverUrl: process.env.IMESSAGE_SERVER_URL,            // e.g. http://127.0.0.1:1234
  password: process.env.IMESSAGE_PASSWORD,               // BlueBubbles server password
  listenHost: process.env.IMESSAGE_LISTEN_HOST || "127.0.0.1", // localhost-only by default
  listenPort: Number(process.env.IMESSAGE_LISTEN_PORT || 1235), // BlueBubbles webhook target
  allow: (process.env.IMESSAGE_ALLOW || "")
    .split(",")
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean),
  get enabled() {
    return Boolean(this.serverUrl && this.password);
  },
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
  calendarDays: Number(process.env.GRAPH_CALENDAR_DAYS ?? 14),
  // Signature appended to emails Lloyd composes (send_email) and replies. \n
  // separated; no em dashes (family style). Override with COS_EMAIL_SIGNATURE.
  signature: (process.env.COS_EMAIL_SIGNATURE || "Warm regards,\nLloyd\nChief of Staff to the Frey Family\n(an automated assistant writing on the family's behalf)")
    .replace(/\\n/g, "\n"),
  // Where the clickable email approval (Approve/Deny mailto buttons) is sent.
  // Comma-separated; empty disables the email approval channel.
  approvalEmailTo: (process.env.APPROVAL_EMAIL_TO ?? "nic@freyfam.com")
    .split(",").map((s) => s.trim()).filter(Boolean),
};

// The family's own email addresses (household + personal + work), so the
// security watch never treats their OWN mail activity as a threat. Override
// with FAMILY_ADDRESSES (comma-separated). Keep in sync with the chief persona's
// family directory.
export const FAMILY_ADDRESSES = (
  process.env.FAMILY_ADDRESSES ||
  "nic@freyfam.com,shelli@freyfam.com,nfrey2@gmail.com,nicholasbfrey@gmail.com,nicholas.frey@flyerdefense.com,shelliafrey@gmail.com,shelli.frey@disney.com,mas324@cornell.edu,foxsfrey@gmail.com"
)
  .split(",")
  .map((s) => s.toLowerCase().trim())
  .filter(Boolean);

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
// Dev backend (workstream Q). Steve (dev) can run on a flat-rate Claude Code
// SUBSCRIPTION instead of the metered API: `backend=claude-code` shells out to
// headless `claude -p` (resolving the OAuth profile) on the MacBook where Steve
// already runs. This takes the heaviest agent off per-token cost AND gives Steve
// real file/bash/build tools. The {agent,task}->text contract is unchanged.
//
// CRITICAL: the child must run with ANTHROPIC_API_KEY unset or it shadows the
// subscription (handled in dev-claude-code.js: subscriptionEnv). Default backend
// stays `api`, so nothing changes until this is flipped on the dev host.
// ---------------------------------------------------------------------------
export const DEV = {
  backend: process.env.COS_DEV_BACKEND || "api",          // 'api' | 'claude-code'
  bin: process.env.CLAUDE_CODE_BIN || "claude",           // headless Claude Code binary
  cwd: process.env.COS_DEV_CWD || process.cwd(),          // workspace Steve operates in
  timeoutMs: Number(process.env.COS_DEV_TIMEOUT_MS || 180000), // a dev task can build/test
  // On a usage cap or backend failure, spill back to the metered API path so a
  // capped subscription degrades to "still works, just metered" instead of erroring.
  fallbackToApi: String(process.env.COS_DEV_FALLBACK_API ?? "true").toLowerCase() === "true",
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

// Weekly finance report (Patrick): Sunday-night spend summary, checking vs
// credit, with MoM/YoY; the first Sunday of the month adds a prior-month
// retrospective. Ships dark (disabled) until FINANCE_REPORT_ENABLED=true.
export const FINANCE_REPORT = {
  enabled: String(process.env.FINANCE_REPORT_ENABLED ?? "false").toLowerCase() === "true",
  weekday: Number(process.env.FINANCE_REPORT_WEEKDAY ?? 0), // 0 = Sunday
  hour: Number(process.env.FINANCE_REPORT_HOUR ?? 20),      // local hour (evening)
  tz: process.env.FAMILY_TZ || "America/Los_Angeles",
  windowHours: Number(process.env.FINANCE_REPORT_WINDOW_HOURS ?? 3),
  // Daily ingest of queued transaction alerts into the spend log (one Haiku
  // batch). Separate flag so ingestion can run even before the report is on.
  ingestEnabled: String(process.env.FINANCE_INGEST_ENABLED ?? "false").toLowerCase() === "true",
  ingestHour: Number(process.env.FINANCE_INGEST_HOUR ?? 6),
  // Owner-only delivery (finance is sensitive). Comma-separated; empty disables email.
  emailTo: (process.env.FINANCE_REPORT_EMAIL_TO || "nic@freyfam.com")
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
