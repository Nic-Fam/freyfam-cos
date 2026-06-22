import { SLACK } from "../config.js";
import { handleInbound } from "../orchestrator.js";
import { delegate } from "../delegate.js";
import { registerApprovalNotifier, resolveByCode } from "../confirm.js";
import { createLogger } from "../log.js";

// ===========================================================================
// Slack "desk" channel via Socket Mode (workstream K). The Mac opens an
// OUTBOUND websocket to Slack - no public endpoint - the same pull-only property
// as the SMS/Azure-queue path. Both human channels feed the SAME orchestrator,
// brain, guards, and confirm gate.
//
//   - DM / #cos  -> the chief (Lloyd): full triage + delegate + #command mirror
//   - #finance #dev #resale #chef #security -> force that specialist persona
//   - #command   -> mirror of every delegation + Block Kit approval buttons
//
// @slack/bolt is an OPTIONAL, lazy-imported dep, and the whole thing is a no-op
// until both tokens are set, so the daemon runs fine without Slack.
// ===========================================================================

const log = createLogger("slack");

// Per-agent channels force a specialist; everything else talks to the chief.
export const CHANNEL_AGENT = {
  finance: "finance",
  dev: "dev",
  resale: "resale",
  chef: "chef",
  security: "security",
};

export function agentForChannel(name) {
  if (!name) return null;
  return CHANNEL_AGENT[String(name).replace(/^#/, "").toLowerCase()] || null;
}

const truncate = (s, n) => {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
};

/** A #command line for one delegation event (the "watch Lloyd run the team" feed). */
export function mirrorText(event) {
  if (!event) return "";
  if (event.phase === "start") return `:arrow_right: *${event.from || "Lloyd"} → ${event.agent}*: ${truncate(event.task, 400)}`;
  if (event.phase === "result") return `:white_check_mark: *${event.agent}*: ${truncate(event.result, 600)}`;
  return "";
}

/** Block Kit Approve/Deny for a pending confirmation `code` (carried in button value). */
export function approvalBlocks(code, action) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Approval needed* (code \`${code}\`)\n${truncate(action, 600)}` } },
    {
      type: "actions",
      block_id: `cos_approval_${code}`,
      elements: [
        { type: "button", action_id: "cos_approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: code },
        { type: "button", action_id: "cos_deny", style: "danger", text: { type: "plain_text", text: "Deny" }, value: code },
      ],
    },
  ];
}

// Slack transport: reply to the originating channel; mirror to #command.
function slackTransport(client, channel) {
  return {
    reply: async (text) => {
      await client.chat.postMessage({ channel, text: String(text ?? "") });
    },
    mirror: async (event) => {
      const text = mirrorText(event);
      if (text) await client.chat.postMessage({ channel: SLACK.commandChannel, text });
    },
  };
}

async function channelName(client, id) {
  try {
    const r = await client.conversations.info({ channel: id });
    return r?.channel?.name || null;
  } catch {
    return null; // DMs / no access -> treat as chief channel
  }
}

/**
 * Start the Slack Socket Mode app. Returns null (no-op) unless both tokens are
 * set or if @slack/bolt isn't installed. Tokens unverifiable here -> live verify
 * needs a real Slack app (see .env.example / TRACKER workstream K).
 */
export async function startSlack() {
  if (!SLACK.enabled) {
    log.info("slack disabled (set SLACK_APP_TOKEN + SLACK_BOT_TOKEN to enable)");
    return null;
  }
  let App;
  try {
    ({ App } = await import("@slack/bolt"));
  } catch {
    log.error("@slack/bolt not installed; run: npm i @slack/bolt");
    return null;
  }

  const app = new App({ token: SLACK.botToken, appToken: SLACK.appToken, socketMode: true });

  app.message(async ({ message, client }) => {
    if (message.subtype || message.bot_id) return; // ignore edits / bot / system
    const text = message.text || "";
    const forced = agentForChannel(await channelName(client, message.channel));
    const transport = slackTransport(client, message.channel);
    try {
      if (forced) {
        await transport.reply(await delegate({ agent: forced, task: text }));
      } else {
        await handleInbound({ from: message.user, body: text, channel: "slack", replyTo: message.channel }, transport);
      }
    } catch (err) {
      log.error("message handling failed", { reason: err.message });
    }
  });

  app.action(/^cos_(approve|deny)$/, async ({ ack, action, body, client }) => {
    await ack();
    const approved = action.action_id === "cos_approve";
    const res = await resolveByCode(action.value, approved);
    const who = body?.user?.username || body?.user?.id || "someone";
    // On approval the staged action ran; surface its result (or error) in-thread.
    let text;
    if (!res.found) text = `Code ${action.value} already resolved or expired`;
    else if (!approved) text = `🚫 denied by ${who} (code ${action.value})`;
    else if (res.error) text = `⚠️ approved by ${who}, but it failed: ${res.error}`;
    else text = `✅ approved by ${who}: ${res.result}`;
    try {
      await client.chat.postMessage({ channel: body.channel.id, thread_ts: body.message?.ts, text });
    } catch {
      /* ignore */
    }
  });

  // Approvals also fan out to Slack as Approve/Deny buttons (SMS path still active).
  registerApprovalNotifier(({ code, action }) => {
    app.client.chat
      .postMessage({ channel: SLACK.commandChannel, text: `Approval needed (code ${code})`, blocks: approvalBlocks(code, action) })
      .catch((e) => log.error("approval post failed", { reason: e.message }));
  });

  await app.start();
  log.info("slack socket mode connected", { commandChannel: SLACK.commandChannel });
  return app;
}
