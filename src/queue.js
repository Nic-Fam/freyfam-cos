import { QueueClient } from "@azure/storage-queue";
import { AZURE } from "./config.js";
import { handleInbound } from "./orchestrator.js";
import { isProcessed, markProcessed, unmarkProcessed } from "./processed-messages.js";
import { createLogger } from "./log.js";

// ===========================================================================
// The Azure Function (public Twilio webhook) drops each inbound SMS/email onto
// this queue and returns immediately. The MacBook PULLS, so it never needs to
// be publicly reachable. If the Mac reboots, messages wait safely in the queue.
//
// Expected message body (JSON):
//   { from, body, channel: "sms"|"email", replyTo?, media?, subject?, graphMessageId? }
// subject (email): retained so the reply threads (Re: <subject>); SMS has none.
// graphMessageId (email): lets the daemon fetch attachments (workstream L).
// media (optional, MMS): [{ url, contentType }] mapped from Twilio MediaUrlN +
// MediaContentTypeN by the front door. The payload is schemaless JSON so media
// flows straight through to handleInbound, which fetches images into Claude
// vision blocks (see src/media.js). Front-door half lives in ~/freyfam-assistant.
//
// A failed message stays invisible only for the visibility timeout, then
// reappears for another attempt. After MAX_DEQUEUE failed deliveries it is
// "poison" -> we move it to the dead-letter queue and delete it from the main
// queue so a single bad message can't cycle forever and starve the consumer.
// ===========================================================================

const log = createLogger("queue");

const MAX_DEQUEUE = Number(process.env.MAX_DEQUEUE || 5);

const queue = new QueueClient(AZURE.queueConnectionString, AZURE.inboundQueue);
const deadLetter = new QueueClient(AZURE.queueConnectionString, AZURE.deadLetterQueue);

let running = false;
let dlqReady = false;

async function deadLetterMessage(m, err) {
  if (!dlqReady) {
    await deadLetter.createIfNotExists();
    dlqReady = true;
  }
  // Preserve the original (base64) body so the DLQ entry is replayable as-is.
  await deadLetter.sendMessage(m.messageText);
  await queue.deleteMessage(m.messageId, m.popReceipt);
  log.error("dead-lettered poison message", {
    deadLetterQueue: AZURE.deadLetterQueue,
    dequeueCount: m.dequeueCount,
    reason: err.message,
  });
}

export async function startQueueConsumer() {
  await queue.createIfNotExists();
  running = true;
  log.info("consuming", { queue: AZURE.inboundQueue, maxDequeue: MAX_DEQUEUE });
  let idleBackoff = 1000;

  while (running) {
    let received;
    try {
      received = await queue.receiveMessages({
        numberOfMessages: 5,
        visibilityTimeout: 120, // hide while we process; reappears if we crash
      });
    } catch (err) {
      log.error("receive failed", { reason: err.message });
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
      // At-least-once dedup: skip a message we already handled (redelivered after a
      // reset/visibility-timeout before it was acked) so confirmations and "YES"
      // approvals never refire. Mark BEFORE handling; unmark on failure to retry.
      if (await isProcessed(m.messageId)) {
        log.info("skipping already-processed message", { messageId: m.messageId, dequeueCount: m.dequeueCount });
        await queue.deleteMessage(m.messageId, m.popReceipt).catch(() => {});
        continue;
      }
      await markProcessed(m.messageId);
      try {
        const payload = JSON.parse(Buffer.from(m.messageText, "base64").toString("utf8"));
        await handleInbound(payload);
        await queue.deleteMessage(m.messageId, m.popReceipt); // ack only on success
      } catch (err) {
        await unmarkProcessed(m.messageId); // let the visibility-timeout redelivery retry a transient failure
        if (m.dequeueCount >= MAX_DEQUEUE) {
          try {
            await deadLetterMessage(m, err);
          } catch (dlqErr) {
            // Leave it on the main queue for another attempt rather than lose it.
            log.error("dead-letter failed; leaving for retry", { reason: dlqErr.message });
          }
        } else {
          // Leave it; visibility timeout returns it for another attempt.
          log.warn("processing failed; will retry", {
            reason: err.message,
            dequeueCount: m.dequeueCount,
            maxDequeue: MAX_DEQUEUE,
          });
        }
      }
    }
  }
}

export function stopQueueConsumer() {
  running = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
