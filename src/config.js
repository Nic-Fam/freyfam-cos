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
// HARD CONSTRAINT: these domains are inbound-read-only. The assistant may READ
// from them but must NEVER send outbound to them. Enforced in src/guards.js.
// ---------------------------------------------------------------------------
export const READ_ONLY_DOMAINS = (
  process.env.READ_ONLY_DOMAINS || "flyerdefense.com,disney.com"
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
  mailbox: process.env.GRAPH_MAILBOX || "cos@freyfam.com", // assistant@ kept as an alias
};

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
};
