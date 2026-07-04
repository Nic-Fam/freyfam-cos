// Credit-card STATEMENT capture for the finance specialist (Patrick). The payment
// due each month is the prior statement's BALANCE, not a sum of recent charges, so
// the transfer outlook needs the statement balance to be accurate. Card issuers
// email a "your statement is ready / balance due $X" notice monthly; this module
// detects those, extracts the balance (one cheap Haiku call, only on a new
// statement email), and stores the latest per card. The transfer outlook prefers
// this over the running-charge estimate.
//
// Best-effort: many "statement ready" emails omit the dollar amount for security
// ("log in to view"); when the balance isn't in the email we capture nothing and
// fall back. Patrick can also set it by hand (set_credit_statement). Surfacing
// only; never moves money.

import { createHash } from "node:crypto";
import { createCollection } from "./stores/collection.js";
import { complete as defaultComplete, textOf, parseJson } from "./claude.js";
import { MODELS } from "./config.js";

const round2 = (x) => Math.round(Number(x) * 100) / 100;

// Same issuers as the transaction-alert senders.
const ISSUER = /@(.*\.)?(chase|americanexpress|aexp|capitalone|discover|citi(bank|cards|group)?)\.com/i;
const STATEMENT_HINT = /(statement.{0,20}(ready|available|is here|posted)|your .{0,20}statement|account statement|new statement|balance due|payment due|autopay|minimum payment)/i;
const SINGLE_TXN = /you made a|transaction with|card was (used|charged)|purchase of/i;

/** A monthly statement / balance-due notice from a card issuer (not a single charge). */
export function isCreditStatement({ from = "", subject = "", body = "" } = {}) {
  if (!ISSUER.test(String(from).toLowerCase())) return false;
  const text = `${subject} ${String(body).slice(0, 500)}`;
  if (SINGLE_TXN.test(text)) return false; // a per-transaction alert, not a statement
  return STATEMENT_HINT.test(text);
}

const col = () =>
  createCollection({ file: process.env.CREDIT_STATEMENT_PATH || "./data/credit-statements.json", partition: "creditstatement" });
const seenStore = () =>
  createCollection({ file: process.env.CREDIT_STATEMENT_SEEN_PATH || "./data/credit-statement-seen.json", partition: "creditstmtseen" });
const seenKey = (m) =>
  createHash("sha1").update(`${m.from || ""}|${m.receivedAt || m.at || ""}|${m.subject || ""}`).digest("hex").slice(0, 16);

const STMT_SYSTEM = `Extract a credit-card STATEMENT summary from one email. Return ONLY JSON:
{"card":<last4 or card name or null>,"statementBalance":<number or null>,"minimumDue":<number or null>,"dueDate":"YYYY-MM-DD"|null}
Rules:
- statementBalance = the NEW BALANCE / statement balance / total balance for this statement (a dollar number). NOT available credit, NOT a single transaction amount.
- If the email does not actually state a dollar balance (e.g. it only says "log in to view"), set statementBalance to null. Do not guess.
- minimumDue = the minimum payment if stated, else null. dueDate = the payment due date if stated, else null.`;

/** One Haiku call to pull the statement balance from a statement email. `complete` injectable. */
export async function extractStatement({ from, subject, body } = {}, { complete = defaultComplete } = {}) {
  const resp = await complete({
    model: MODELS.triage,
    system: STMT_SYSTEM,
    messages: [{ role: "user", content: `FROM: ${from || ""}\nSUBJECT: ${subject || ""}\n${String(body || "").slice(0, 1500)}` }],
    maxTokens: 300, // complete() expects maxTokens (max_tokens was silently ignored -> defaulted to 1024)
  });
  const out = parseJson(textOf(resp)) || {};
  const num = (x) => (typeof x === "number" && Number.isFinite(x) ? round2(x) : null);
  return {
    card: out.card ? String(out.card) : null,
    statementBalance: num(out.statementBalance),
    minimumDue: num(out.minimumDue),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test(out.dueDate || "") ? out.dueDate : null,
  };
}

/** Record/replace the latest statement for a card (upsert by card). */
export async function setStatement({ card, statementBalance, minimumDue = null, dueDate = null, source = null } = {}) {
  if (statementBalance == null || Number.isNaN(Number(statementBalance))) throw new Error("statementBalance is required");
  const id = `card:${String(card || "default").toLowerCase().trim()}`;
  const c = col();
  await c.remove(id).catch(() => {});
  const item = {
    id, card: card ? String(card) : "default",
    statementBalance: round2(statementBalance),
    minimumDue: minimumDue == null ? null : round2(minimumDue),
    dueDate, source, capturedAt: new Date().toISOString(),
  };
  await c.add(item);
  return item;
}

export async function listStatements() {
  return col().list();
}

/**
 * The credit-card payment due in the upcoming cycle: the latest statement balance
 * per card, summed, using only statements captured within `freshDays` (a stale one
 * is ignored so we never plan against last quarter's balance). Returns null if none.
 */
export async function currentStatementPayment({ now = new Date(), freshDays = 45 } = {}) {
  const cutoff = now.getTime() - freshDays * 86400000;
  const fresh = (await listStatements()).filter(
    (s) => s.statementBalance != null && Date.parse(s.capturedAt) >= cutoff
  );
  if (!fresh.length) return null;
  return { total: round2(fresh.reduce((a, s) => a + s.statementBalance, 0)), cards: fresh.length, items: fresh };
}

/**
 * Scan recent inbox mail for statement notices and capture balances (deduped, one
 * Haiku call per new statement email). `mails` are {from, subject, body, receivedAt}.
 */
export async function scanInboxForStatements(mails = [], { complete = defaultComplete } = {}) {
  const store = seenStore();
  const seen = new Set((await store.list()).map((s) => s.id));
  let captured = 0, examined = 0;
  for (const m of mails || []) {
    if (!isCreditStatement(m)) continue;
    const id = seenKey(m);
    if (seen.has(id)) continue;
    seen.add(id);
    await store.add({ id, at: new Date().toISOString() }); // one shot per email (no re-Haiku)
    examined++;
    try {
      const ex = await extractStatement(m, { complete });
      if (ex.statementBalance != null) { await setStatement({ ...ex, source: m.from }); captured++; }
    } catch { /* transient extraction error: skip; manual entry covers misses */ }
  }
  return { examined, captured };
}
