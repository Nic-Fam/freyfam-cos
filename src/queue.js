import { QueueClient } from "@azure/storage-queue";
import { AZURE } from "./config.js";
import { handleInbound } from "./orchestrator.js";

// ===========================================================================
// The Azure Function (public Twilio webhook) drops each inbound SMS/email onto
// this queue and returns immediately. The MacBook PULLS, so it never needs to
// be publicly reachable. If the Mac reboots, messages wait safely in the queue.
//
// Expected message body (JSON): { from, body, channel: "sms"|"email", replyTo? }
// ===========================================================================

const queue = new QueueClient(AZURE.queueConnectionString, AZURE.inboundQueue);

let running = false;

export async function startQueueConsumer() {
  await queue.createIfNotExists();
  running = true;
  console.log(`[queue] consuming "${AZURE.inboundQueue}"`);
  let idleBackoff = 1000;

  while (running) {
    let received;
    try {
      received = await queue.receiveMessages({
        numberOfMessages: 5,
        visibilityTimeout: 120, // hide while we process; reappears if we crash
      });
    } catch (err) {
      console.error("[queue] receive failed:", err.message);
      await sleep(5000);
      continue;
    }

    const msgs = received.receivedMessageItems || [];
    if (msgs.length === 0) {
      await sleep(idleBackoff);
      idleBackoff = Math.min(idleBackoff * 2, 20000); // long-poll-ish backoff
      continue;
    }
    idleBackoff = 1000;

    for (const m of msgs) {
      try {
        const payload = JSON.parse(Buffer.from(m.messageText, "base64").toString("utf8"));
        await handleInbound(payload);
        await queue.deleteMessage(m.messageId, m.popReceipt); // ack only on success
      } catch (err) {
        console.error("[queue] processing failed (will retry):", err.message);
        // Leave it; visibility timeout returns it for another attempt.
        // TODO (Claude Code): dead-letter after N dequeues using m.dequeueCount.
      }
    }
  }
}

export function stopQueueConsumer() {
  running = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
