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
};

export const GRAPH = {
  tenantId: process.env.GRAPH_TENANT_ID,
  clientId: process.env.GRAPH_CLIENT_ID,
  clientSecret: process.env.GRAPH_CLIENT_SECRET,
  mailbox: process.env.GRAPH_MAILBOX || "assistant@freyfam.com",
};

export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
