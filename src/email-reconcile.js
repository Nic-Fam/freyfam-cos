// Daemon-side inbound EMAIL reconcile: the self-healing safety net that makes
// email intake independent of the legacy Azure front door. Each heartbeat we
// read the cos mailbox and any FAMILY email we have not seen before is enqueued
// onto inbound-messages in the SAME envelope the front door used
//   { from, body, channel: "email", subject, graphMessageId, replyTo }
// so the queue consumer handles it exactly like a webhook-delivered message.
//
// Dedup is a per-email seen-set keyed by Graph message id (pluggable store, same
// as the finance alert-seen set). The FIRST run BASELINES: it marks every
// current inbox id seen and enqueues NOTHING, so deploying this never replays
// already-answered history. Only mail that arrives AFTER the baseline is
// enqueued. Bank/card alerts and the mailbox's own addresses are excluded; only
// senders in FAMILY_ADDRESSES are eligible (the front door applied the same gate).

import { QueueClient } from "@azure/storage-queue";
import { AZURE, GRAPH, FAMILY_ADDRESSES } from "./config.js";
import { recentInboxFull } from "./channels/graph.js";
import { isTransactionAlert } from "./finance-ingest.js";
import { createCollection } from "./stores/collection.js";
import { createLogger } from "./log.js";

const log = createLogger("email-reconcile");

const BASELINE_ID = "__baseline__";

const seenStore = () =>
  createCollection({
    file: process.env.EMAIL_RECONCILE_PATH || "./data/reconciled-emails.json",
    partition: "reconciledemails",
  });

const family = new Set(FAMILY_ADDRESSES.map((a) => String(a).toLowerCase()));
const SELF = new Set(
  [GRAPH.mailbox, "cos@freyfam.com", "assistant@freyfam.com"].map((a) => String(a).toLowerCase())
);

function isFamilySender(from) {
  const f = String(from || "").toLowerCase();
  return family.has(f) && !SELF.has(f);
}

/** Default enqueue: base64 JSON onto the inbound-messages queue (front-door format). */
async function enqueueInbound(payload) {
  const q = new QueueClient(AZURE.queueConnectionString, AZURE.inboundQueue);
  await q.createIfNotExists();
  await q.sendMessage(Buffer.from(JSON.stringify(payload)).toString("base64"));
}

/**
 * Read the mailbox, enqueue any not-yet-seen family email. `fetch` and `enqueue`
 * are injectable for tests. Returns {baseline, scanned, enqueued}.
 */
export async function reconcileInboundEmail({
  fetch = recentInboxFull,
  enqueue = enqueueInbound,
  top = 25,
} = {}) {
  const mails = await fetch({ top });
  const store = seenStore();
  const existing = await store.list();
  const seen = new Set(existing.map((s) => s.id));
  const baselined = seen.has(BASELINE_ID);

  // FIRST run: record everything currently in the inbox as seen and enqueue
  // nothing, so we never replay already-answered mail.
  if (!baselined) {
    for (const m of mails) if (m.id && !seen.has(m.id)) { await store.add({ id: m.id, at: m.receivedAt || null }); seen.add(m.id); }
    await store.add({ id: BASELINE_ID, at: new Date().toISOString() });
    log.info("email reconcile baselined", { marked: seen.size, scanned: mails.length });
    return { baseline: true, scanned: mails.length, enqueued: 0 };
  }

  let enqueued = 0;
  for (const m of mails) {
    if (!m.id || seen.has(m.id)) continue;
    if (!isFamilySender(m.from)) continue;            // only the family's own addresses
    if (isTransactionAlert({ from: m.from, subject: m.subject, body: m.body })) continue;
    await enqueue({
      from: m.from,
      body: m.body || m.subject || "",
      channel: "email",
      subject: m.subject || "",
      graphMessageId: m.id,
      replyTo: m.from,
    });
    await store.add({ id: m.id, at: m.receivedAt || null });
    seen.add(m.id);
    enqueued++;
    log.info("reconciled inbound email -> queue", { from: m.from, subject: (m.subject || "").slice(0, 60) });
  }
  return { baseline: false, scanned: mails.length, enqueued };
}
