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
// How long a received message stays hidden while we work on it. A chief turn can
// run a 12-tool Opus loop or a browser crawl, so 2 minutes (the old value) was
// routinely exceeded: the message became visible again, the pop receipt went
// stale, the final delete threw, and the "failure" path unmarked + re-ran the
// whole turn (duplicate replies + duplicate staged approvals). Now: a longer
// default AND a lease that is renewed while handling runs (see withLease).
const VISIBILITY_S = Number(process.env.QUEUE_VISIBILITY_SECONDS || 600);
const RENEW_EVERY_MS = Math.max(15_000, Math.floor((VISIBILITY_S * 1000) / 3));

const queue = new QueueClient(AZURE.queueConnectionString, AZURE.inboundQueue);
const deadLetter = new QueueClient(AZURE.queueConnectionString, AZURE.deadLetterQueue);

let running = false;
let dlqReady = false;

async function deadLetterMessage(q, m, err) {
  if (!dlqReady) {
    await deadLetter.createIfNotExists();
    dlqReady = true;
  }
  // Preserve the original (base64) body so the DLQ entry is replayable as-is.
  await deadLetter.sendMessage(m.messageText);
  await q.deleteMessage(m.messageId, m.popReceipt);
  log.error("dead-lettered poison message", {
    deadLetterQueue: AZURE.deadLetterQueue,
    dequeueCount: m.dequeueCount,
    reason: err.message,
  });
}

/**
 * Keep a received message invisible while `work` runs by extending its
 * visibility timeout on a timer. Each `updateMessage` returns a NEW pop
 * receipt, which `m.popReceipt` is updated to (the later delete needs it).
 * A failed renewal is logged and the loop keeps going; the dedup store still
 * protects a redelivery that slips through. Pure plumbing; `q` injectable.
 */
export async function withLease(q, m, work, { visibilityS = VISIBILITY_S, everyMs = RENEW_EVERY_MS, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let renewing = false;
  const timer = setTimer(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const r = await q.updateMessage(m.messageId, m.popReceipt, undefined, visibilityS);
      if (r?.popReceipt) m.popReceipt = r.popReceipt;
      log.debug("lease renewed", { messageId: m.messageId });
    } catch (err) {
      log.warn("lease renewal failed", { messageId: m.messageId, reason: err.message });
    } finally {
      renewing = false;
    }
  }, everyMs);
  try {
    return await work();
  } finally {
    clearTimer(timer);
  }
}

/**
 * Process ONE received message end to end: dedup, handle under a lease, ack.
 * Exported (with injectable queue + handler) so the retry/dedup/dead-letter
 * rules are unit-testable without Azure. Rules:
 *   - mark processed BEFORE handling; unmark ONLY if handling itself failed
 *     (so a transient failure retries) — never when the handler succeeded but
 *     the ack failed, because the side effects already happened and the dedup
 *     mark is exactly what stops the redelivery from re-running them.
 *   - after MAX_DEQUEUE failed deliveries the message is dead-lettered.
 */
export async function processMessage(m, { q = queue, handler = handleInbound, maxDequeue = MAX_DEQUEUE, lease = withLease } = {}) {
  if (await isProcessed(m.messageId)) {
    log.info("skipping already-processed message", { messageId: m.messageId, dequeueCount: m.dequeueCount });
    await q.deleteMessage(m.messageId, m.popReceipt).catch(() => {});
    return "duplicate";
  }
  await markProcessed(m.messageId);
  let handled = false;
  try {
    await lease(q, m, async () => {
      const payload = JSON.parse(Buffer.from(m.messageText, "base64").toString("utf8"));
      await handler(payload);
    });
    handled = true;
    await q.deleteMessage(m.messageId, m.popReceipt); // ack only on success
    return "handled";
  } catch (err) {
    if (handled) {
      // Handled fine; only the ack failed (stale receipt, network). Keep the dedup
      // mark: if the queue redelivers, the duplicate branch above deletes it.
      log.warn("ack failed after successful handling; dedup will absorb the redelivery", { reason: err.message });
      return "handled-unacked";
    }
    await unmarkProcessed(m.messageId); // let the visibility-timeout redelivery retry a transient failure
    if (m.dequeueCount >= maxDequeue) {
      try {
        await deadLetterMessage(q, m, err);
        return "dead-lettered";
      } catch (dlqErr) {
        // Leave it on the main queue for another attempt rather than lose it.
        log.error("dead-letter failed; leaving for retry", { reason: dlqErr.message });
        return "retry";
      }
    }
    // Leave it; visibility timeout returns it for another attempt.
    log.warn("processing failed; will retry", {
      reason: err.message,
      dequeueCount: m.dequeueCount,
      maxDequeue,
    });
    return "retry";
  }
}

export async function startQueueConsumer() {
  await queue.createIfNotExists();
  running = true;
  log.info("consuming", { queue: AZURE.inboundQueue, maxDequeue: MAX_DEQUEUE, visibilityS: VISIBILITY_S });
  let idleBackoff = 1000;

  while (running) {
    let received;
    try {
      received = await queue.receiveMessages({
        numberOfMessages: 5,
        visibilityTimeout: VISIBILITY_S, // hide while we process; renewed under withLease
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

    for (const m of msgs) await processMessage(m);
  }
}

export function stopQueueConsumer() {
  running = false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
