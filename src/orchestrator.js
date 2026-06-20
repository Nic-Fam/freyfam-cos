import { agentLoop, systemBlocks } from "./claude.js";
import { modelForComplexity } from "./config.js";
import { triageInbound } from "./triage.js";
import { recall, remember } from "./memory.js";
import { logDecision, listDecisions } from "./decisions.js";
import { requestConfirmation, tryResolveConfirmation } from "./confirm.js";
import { sendSms } from "./channels/twilio.js";
import { recentMailSignals, sendMail } from "./channels/graph.js";
import { persona } from "./persona.js";
import { delegate } from "./delegate.js";
import { readPage, runOrder } from "./channels/browser.js";
import { fetchInboundMedia } from "./media.js";

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

function toolHandlers({ images } = {}) {
  return {
    recall_memory: async ({ query }) => JSON.stringify(await recall(query)),
    remember: async ({ text }) => {
      await remember(text);
      return "saved";
    },
    log_decision: async (input) => JSON.stringify(await logDecision("chief-of-staff", input)),
    list_decisions: async ({ agent } = {}) => JSON.stringify(await listDecisions(agent || "chief-of-staff")),
    // `images` rides along from the inbound turn (MMS photos) so the specialist
    // sees the actual picture. The tool schema stays {agent, task}: the model
    // never re-emits image bytes; they come from context.
    delegate: async ({ agent, task }) => delegate({ agent, task, images }),
    send_email: async ({ to, subject, body }) => {
      const ok = await requestConfirmation(`Email to ${to}\nSubject: ${subject}\n${body.slice(0, 200)}`);
      if (!ok) return "Owner declined; email not sent.";
      await sendMail({ to, subject, body }); // guard inside blocks read-only domains
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
export async function runChief(body, model, { content, images } = {}) {
  const p = await persona("chief-of-staff");
  const mems = await recall(body, 4); // recall always keys off the text
  const volatile =
    `Now: ${new Date().toISOString()}\n` +
    (mems.length ? `Relevant memory:\n${mems.map((m) => "- " + m.text).join("\n")}` : "");
  const { text } = await agentLoop({
    model,
    system: systemBlocks(p, volatile),
    // `content` (text + image blocks) wins when an MMS carried photos; else plain text.
    messages: [{ role: "user", content: content || body }],
    tools,
    toolHandlers: toolHandlers({ images }), // forwarded to specialists on delegate
  });
  return text;
}

export async function handleInbound(msg) {
  // 0. Is this a YES/NO answer to a pending approval? If so, it's already handled.
  if (tryResolveConfirmation(msg.body)) return;

  // 1. If the message carried photos (MMS), fetch them into Claude image blocks.
  //    Lloyd is multimodal here: he can read a receipt / see an item and then
  //    delegate to Carmine (groceries) or Shey (resale). Failures are non-fatal.
  let content;
  let images;
  let triageText = msg.body || "";
  if (Array.isArray(msg.media) && msg.media.length) {
    const { imageBlocks } = await fetchInboundMedia(msg.media);
    if (imageBlocks.length) {
      images = imageBlocks;
      content = [{ type: "text", text: msg.body?.trim() || "(photo attached, no caption)" }, ...imageBlocks];
      triageText = `${msg.body || ""}\n[${imageBlocks.length} photo(s) attached]`.trim();
    }
  }

  // 2. Cheap classification -> pick the cheapest sufficient model.
  const t = await triageInbound(triageText);
  const model = modelForComplexity(t.complexity, t.high_stakes);

  // 3. Run the chief of staff (or answer trivially on Haiku). recall keys off the
  //    text; `content` carries the images to Lloyd, `images` forwards them to any
  //    specialist he delegates to this turn.
  const text = await runChief(msg.body || "(photo message)", model, { content, images });

  // 4. Reply on the channel it came in on.
  if (msg.channel === "sms") await sendSms(msg.replyTo || msg.from, text);
  else if (msg.channel === "email") {
    await sendMail({ to: msg.replyTo || msg.from, subject: "Re: your note", body: text });
  }
  return text;
}

// Re-export for the heartbeat to escalate actionable items into real runs.
export { recentMailSignals };
