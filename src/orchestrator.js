import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { agentLoop, systemBlocks } from "./claude.js";
import { MODELS, modelForComplexity } from "./config.js";
import { triageInbound } from "./triage.js";
import { recall, remember } from "./memory.js";
import { requestConfirmation, tryResolveConfirmation } from "./confirm.js";
import { sendSms } from "./channels/twilio.js";
import { recentMailSignals, sendMail } from "./channels/graph.js";
import { specialistTools } from "./agents/tools.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const personaCache = new Map();
async function persona(name) {
  if (personaCache.has(name)) return personaCache.get(name);
  const text = await readFile(join(__dir, "agents", `${name}.md`), "utf8");
  personaCache.set(name, text);
  return text;
}

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
    name: "delegate",
    description: "Hand a scoped task to a specialist agent and get their result.",
    input_schema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: ["finance", "dev", "resale"] },
        task: { type: "string" },
      },
      required: ["agent", "task"],
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
];

async function runSpecialist(agent, task) {
  const p = await persona(agent);
  const mems = await recall(task, 4, { agent });
  const ctx = mems.length ? `Relevant memory:\n${mems.map((m) => "- " + m.text).join("\n")}` : "";
  const { tools: specTools, handlers: specHandlers } = specialistTools(agent);
  const { text } = await agentLoop({
    model: MODELS.standard,
    system: systemBlocks(p, ctx),
    messages: [{ role: "user", content: task }],
    tools: specTools,
    toolHandlers: specHandlers,
    maxTurns: 6,
  });
  return text;
}

function toolHandlers() {
  return {
    recall_memory: async ({ query }) => JSON.stringify(await recall(query)),
    remember: async ({ text }) => {
      await remember(text);
      return "saved";
    },
    delegate: async ({ agent, task }) => runSpecialist(agent, task),
    send_email: async ({ to, subject, body }) => {
      const ok = await requestConfirmation(`Email to ${to}\nSubject: ${subject}\n${body.slice(0, 200)}`);
      if (!ok) return "Owner declined; email not sent.";
      await sendMail({ to, subject, body }); // guard inside blocks read-only domains
      return "Email sent.";
    },
  };
}

/**
 * Main entry for an inbound family message. Triage first (cheap), then route to
 * the right agent at the right model tier, then reply over the same channel.
 * @param {{from:string, body:string, channel:"sms"|"email", replyTo?:string}} msg
 */
export async function handleInbound(msg) {
  // 0. Is this a YES/NO answer to a pending approval? If so, it's already handled.
  if (tryResolveConfirmation(msg.body)) return;

  // 1. Cheap classification -> pick the cheapest sufficient model.
  const t = await triageInbound(msg.body);
  const model = modelForComplexity(t.complexity, t.high_stakes);

  // 2. Run the chief of staff (or answer trivially on Haiku).
  const p = await persona("chief-of-staff");
  const mems = await recall(msg.body, 4);
  const volatile =
    `Now: ${new Date().toISOString()}\n` +
    (mems.length ? `Relevant memory:\n${mems.map((m) => "- " + m.text).join("\n")}` : "");

  const { text } = await agentLoop({
    model,
    system: systemBlocks(p, volatile),
    messages: [{ role: "user", content: msg.body }],
    tools,
    toolHandlers: toolHandlers(),
  });

  // 3. Reply on the channel it came in on.
  if (msg.channel === "sms") await sendSms(msg.replyTo || msg.from, text);
  else if (msg.channel === "email") {
    await sendMail({ to: msg.replyTo || msg.from, subject: "Re: your note", body: text });
  }
  return text;
}

// Re-export for the heartbeat to escalate actionable items into real runs.
export { recentMailSignals };
