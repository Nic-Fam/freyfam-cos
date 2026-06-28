// Silent ingestion of bank/card transaction alert emails for the finance log.
// Per the cost design, transaction alerts must NOT wake the interactive pipeline
// (triage + chief + specialist per message). Instead:
//   1. handleInbound recognizes an alert by sender (cheap string match, NO model)
//      and files it here with queueAlert() — no triage, no reply.
//   2. Once a day, buildDailyIngest() drains the queue and makes ONE Haiku call to
//      extract the batch into structured transactions; a reconcile pass retries
//      whatever didn't parse; the rest is flagged. Parsed rows go to the spend log
//      tagged with their source (credit vs checking).
// So model usage is ~1 cheap call/day, not one per transaction.

import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createCollection } from "./stores/collection.js";
import { complete as defaultComplete, textOf, parseJson } from "./claude.js";
import { MODELS } from "./config.js";
import { logTransaction } from "./finance-log.js";

// --- 1. cheap detection (no model) ------------------------------------------
// Known bank/card ALERT senders. Chase uses the same alert sender for card and
// checking, so we do NOT decide source here — the extractor reads the content
// and tags each transaction's source. Statements/marketing are filtered out by
// requiring a transaction-ish subject/body, so they still flow normally.
const ALERT_SENDERS = [
  /@(.*\.)?chase\.com/i,
  /@(.*\.)?americanexpress\.com/i,
  /@(.*\.)?aexp\.com/i,
  /@(.*\.)?capitalone\.com/i,
  /@(.*\.)?discover\.com/i,
  /@(.*\.)?citi(bank|cards|group)?\.com/i,
];
const TXN_SUBJECT = /(transaction|purchase|charge|debit|withdraw|deposit|payment|you (made|used|spent)|card was (used|charged)|account activity)/i;

export function isTransactionAlert({ from = "", subject = "", body = "" } = {}) {
  const f = String(from).toLowerCase();
  if (!ALERT_SENDERS.some((re) => re.test(f))) return false;
  return TXN_SUBJECT.test(String(subject)) || /\$\s?\d/.test(String(body).slice(0, 600));
}

// --- pending queue ----------------------------------------------------------
const inbox = () =>
  createCollection({ file: process.env.FINANCE_INBOX_PATH || "./data/finance-inbox.json", partition: "financeinbox" });

export async function queueAlert({ from, subject, body, at } = {}) {
  const item = {
    id: randomUUID().slice(0, 8),
    from: from || null,
    subject: subject || null,
    body: String(body || "").slice(0, 2000),
    at: at || new Date().toISOString(),
  };
  await inbox().add(item);
  return item;
}

export async function peekAlerts() {
  return inbox().list();
}

// --- mailbox scan: pull alerts the front door dropped --------------------------
// Bank/card ALERT senders (no.reply.alerts@chase.com, etc.) are "automated", so the
// front door does NOT enqueue them to the cos queue - they only ever sit in the cos
// mailbox. So the heartbeat scans the inbox directly and queues any transaction
// alert it finds, exactly like the shipment scanner does for carrier no-reply mail.
// Deduped against a persisted seen-set (keyed by sender+received-time+subject) so a
// repeated scan never double-queues the same alert before the daily ingest drains it.
const alertSeen = () =>
  createCollection({ file: process.env.FINANCE_ALERT_SEEN_PATH || "./data/finance-alert-seen.json", partition: "financealertseen" });
const alertKey = (m) =>
  createHash("sha1").update(`${m.from || ""}|${m.receivedAt || m.at || ""}|${m.subject || ""}`).digest("hex").slice(0, 16);

/**
 * Scan a batch of recent inbox messages, queue the ones that are transaction
 * alerts (deduped), and return how many were newly queued. `mails` are
 * {from, subject, body, receivedAt}. Pure of network; the caller fetches the mail.
 */
export async function scanInboxForAlerts(mails = []) {
  const store = alertSeen();
  const seen = new Set((await store.list()).map((s) => s.id));
  let queued = 0;
  for (const m of mails || []) {
    if (!isTransactionAlert({ from: m.from, subject: m.subject, body: m.body })) continue;
    const id = alertKey(m);
    if (seen.has(id)) continue;
    seen.add(id);
    await queueAlert({ from: m.from, subject: m.subject, body: m.body, at: m.receivedAt });
    await store.add({ id, at: new Date().toISOString() });
    queued++;
  }
  return { scanned: (mails || []).length, queued };
}

// Persisted once-per-day guard for the ingest batch (survives restarts).
const ingestStatePath = () => process.env.FINANCE_INGEST_STATE_PATH || "./data/finance-ingest-state.json";
export async function getLastIngestDate() {
  try { return JSON.parse(await readFile(ingestStatePath(), "utf8")).lastRunDate || null; } catch { return null; }
}
export async function setLastIngestDate(date) {
  await mkdir(dirname(ingestStatePath()), { recursive: true });
  await writeFile(ingestStatePath(), JSON.stringify({ lastRunDate: date }, null, 2));
}

export async function drainAlerts() {
  const c = inbox();
  const items = await c.list();
  for (const it of items) await c.remove(it.id);
  return items;
}

// --- 2. one-shot extraction (Haiku) -----------------------------------------
const EXTRACT_SYSTEM = `You convert bank/credit-card transaction ALERT emails into structured data.
You are given a numbered list of alert emails. Return ONLY a JSON object:
{"transactions":[{"i":<index>,"date":"YYYY-MM-DD","merchant":<string>,"amount":<number>,"card":<string|null>,"source":"credit"|"checking","direction":"in"|"out","balance":<number|null>}],"unparsed":[<index>,...]}
Rules:
- amount = the positive dollar amount of the single transaction.
- source = "checking" if the alert is about a checking/debit/deposit/withdrawal on a bank account; "credit" if it is a credit-card purchase/charge.
- direction = "in" if money ENTERS the account (a deposit, refund, or payment received into checking); "out" if money LEAVES (a debit, withdrawal, or a credit-card purchase/charge). A normal card purchase is "out".
- balance = the account's available/posted balance AFTER this transaction if the alert states one (a dollar number), else null. Do NOT invent it.
- card = the last 4 digits or the card/account name if present, else null.
- Put an index in "unparsed" if the email is NOT a single posted transaction (statement notice, marketing, balance summary) or you cannot find a clear amount.`;

function renderBatch(alerts) {
  return alerts
    .map((a, i) => `[${i}] FROM: ${a.from || ""}\nSUBJECT: ${a.subject || ""}\n${String(a.body || "").slice(0, 800)}`)
    .join("\n---\n");
}

/**
 * One model call over a batch of alerts. Returns parsed transactions (each with
 * its originating alert) and the alerts that could not be parsed.
 * `complete` is injectable for tests.
 */
export async function extractTransactions(alerts, { complete = defaultComplete, model = MODELS.triage } = {}) {
  if (!alerts || !alerts.length) return { parsed: [], unparsed: [] };
  const resp = await complete({
    model,
    system: EXTRACT_SYSTEM,
    messages: [{ role: "user", content: renderBatch(alerts) }],
    max_tokens: 1500,
  });
  const out = parseJson(textOf(resp)) || {};
  const txns = Array.isArray(out.transactions) ? out.transactions : [];
  const parsed = [];
  const used = new Set();
  for (const t of txns) {
    const alert = alerts[t.i];
    if (!alert || typeof t.amount !== "number" || !Number.isFinite(t.amount)) continue;
    used.add(t.i);
    parsed.push({
      amount: t.amount,
      date: t.date || null,
      merchant: t.merchant || null,
      card: t.card || null,
      source: t.source === "checking" ? "checking" : "credit",
      direction: t.direction === "in" ? "in" : "out",
      balance: typeof t.balance === "number" && Number.isFinite(t.balance) ? t.balance : null,
      alert,
    });
  }
  const unparsed = alerts.filter((_, i) => !used.has(i));
  return { parsed, unparsed };
}

// --- 3. daily build: extract + reconcile + log ------------------------------
/**
 * Drain the queued alerts, extract them (one Haiku call), run a reconcile pass
 * over whatever didn't parse, log the parsed transactions, and return a summary.
 * Anything still unparsed after reconcile is returned as `flagged` (raw) so the
 * report can surface it rather than silently dropping it.
 */
export async function buildDailyIngest({ complete = defaultComplete } = {}) {
  const alerts = await drainAlerts();
  if (!alerts.length) return { alerts: 0, logged: 0, flagged: [] };

  const first = await extractTransactions(alerts, { complete });
  let parsed = first.parsed;
  let leftovers = first.unparsed;

  // Reconcile pass: a second, focused extraction over just the stragglers.
  if (leftovers.length) {
    const recon = await extractTransactions(leftovers, { complete });
    parsed = parsed.concat(recon.parsed);
    leftovers = recon.unparsed;
  }

  let logged = 0;
  for (const t of parsed) {
    await logTransaction({ amount: t.amount, date: t.date, merchant: t.merchant, card: t.card, source: t.source, direction: t.direction, balance: t.balance, at: t.alert?.at });
    logged++;
  }
  return { alerts: alerts.length, logged, flagged: leftovers };
}
