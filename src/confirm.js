import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createLogger } from "./log.js";

// ===========================================================================
// Human-in-the-loop gate (hard constraint #2). Any high-stakes action — sending
// mail on the family's behalf, a purchase, a calendar invite — must pass through
// here. The action runs ONLY on an explicit approval.
//
// DEFERRED + PERSISTED by design:
//  - Deferred (non-blocking): the queue consumer is serial, so a confirmation
//    that blocked the turn awaiting "YES" dead-locked the daemon (the turn held
//    the consumer, so the reply could never be read). We stage and return a code
//    immediately; the turn ends; the reply resolves it later.
//  - Persisted: a staged action is stored by KIND + serializable PARAMS (NOT a
//    closure), so it survives a daemon restart — the nightly 4am restart used to
//    silently drop pending approvals. The orchestrator registers a handler per
//    kind at boot; resolving an approval dispatches to it.
//
// Slack is wired without an import cycle: slack.js registers a notifier and calls
// resolveByCode for button taps. confirm.js never imports slack.js or the
// orchestrator (handlers come in via registerActionHandler).
// ===========================================================================

const log = createLogger("confirm");

const PENDING_PATH = () => process.env.PENDING_APPROVALS_PATH || "./data/pending-approvals.json";
const TTL_MS = Number(process.env.APPROVAL_TTL_MS ?? 12 * 60 * 60 * 1000); // 12h: survive an overnight restart

const handlers = new Map(); // kind -> async (params) => resultString
const notifiers = new Set(); // extra approval channels (e.g. Slack) -> fn({code, action})

/** Register the executor for an action kind (called once at boot by the orchestrator). */
export function registerActionHandler(kind, fn) {
  handlers.set(kind, fn);
}

/** Register an extra approval notifier (e.g. Slack). Returns an unregister fn. */
export function registerApprovalNotifier(fn) {
  notifiers.add(fn);
  return () => notifiers.delete(fn);
}

// --- persisted pending store (prune expired on every read/write) ------------

async function loadPending(now = Date.now()) {
  let obj = {};
  try {
    obj = JSON.parse(await readFile(PENDING_PATH(), "utf8"));
  } catch {
    return new Map();
  }
  const map = new Map();
  for (const [code, e] of Object.entries(obj || {})) {
    if (e && now - (e.createdAt || 0) <= TTL_MS) map.set(code, e);
  }
  return map;
}

async function savePending(map) {
  await mkdir(dirname(PENDING_PATH()), { recursive: true });
  await writeFile(PENDING_PATH(), JSON.stringify(Object.fromEntries(map), null, 2));
}

// Recently-resolved codes: a code the family JUST approved/denied is remembered
// briefly so a duplicate reply (the pre-filled "YES" arriving twice, or a webhook +
// reconcile double-deliver) is recognized as "already handled" instead of firing an
// alarming "unknown or expired" notice -- which then reads to Frank like a forged code.
const RESOLVED_PATH = () => process.env.RESOLVED_APPROVALS_PATH || PENDING_PATH().replace(/\.json$/i, "") + "-resolved.json";
async function loadResolved(now = Date.now()) {
  let obj = {};
  try { obj = JSON.parse(await readFile(RESOLVED_PATH(), "utf8")); } catch { return new Map(); }
  const map = new Map();
  for (const [code, e] of Object.entries(obj || {})) {
    if (e && now - (e.at || 0) <= TTL_MS) map.set(code, e);
  }
  return map;
}
async function recordResolved(code, entry, approved, now = Date.now()) {
  const map = await loadResolved(now);
  map.set(code, { at: now, action: entry.action, approved });
  await mkdir(dirname(RESOLVED_PATH()), { recursive: true });
  await writeFile(RESOLVED_PATH(), JSON.stringify(Object.fromEntries(map), null, 2));
}

const approvalRecipient = (params) =>
  String((params || {}).to || (params || {}).recipient || "").toLowerCase().trim();

// How many pending approvals to the SAME kind+recipient before we stop pinging
// the owner about more. A misfiring loop (security false-positive, etc.) that
// re-asks every tick should ping at most this many times per TTL window, not 24.
const NOTIFY_CAP = Number(process.env.APPROVAL_NOTIFY_CAP || 3);

/**
 * Stage a high-stakes action for approval and return its code immediately (does
 * NOT block, persists across restarts). `kind` selects the registered executor;
 * `params` must be JSON-serializable and is passed to that executor on approval.
 *
 * Flood guard: the action ALWAYS stages (nothing is ever dropped — this is the
 * safety gate), but once NOTIFY_CAP approvals to the same kind+recipient are
 * already pending, further ones stage SILENTLY (no owner ping) and return
 * `throttled:true`. This caps the alert spam from a re-asking loop without ever
 * losing or merging a distinct approval; it only suppresses a redundant ping.
 * @returns {Promise<{code:string, instruction:string, throttled?:boolean}>}
 */
export async function requestConfirmation(actionDescription, kind, params, { now = Date.now(), thread = null } = {}) {
  if (!handlers.has(kind)) throw new Error(`no action handler registered for kind "${kind}"`);
  // 6 hex chars (16.7M combos) from a CSPRNG, up from 4 (65k). Combined with the
  // owner-only submission gate (only an authorized sender's YES reaches this — see
  // orchestrator.handleInbound) and the short TTL, brute force is not feasible.
  const code = randomBytes(3).toString("hex").toUpperCase();
  const pending = await loadPending(now);

  const to = approvalRecipient(params);
  const sameTarget = [...pending.values()].filter(
    (e) => e && e.kind === kind && approvalRecipient(e.params) === to
  ).length;

  // `thread` (source email's {messageId, subject}) lets the email approval notifier
  // reply INSIDE that conversation instead of sending a standalone approval email.
  pending.set(code, { kind, params, action: actionDescription, createdAt: now, thread });
  await savePending(pending);

  // Suppress the ping (only) once this recipient+kind is clearly piling up.
  const throttled = Boolean(to) && sameTarget >= NOTIFY_CAP;
  if (!throttled) {
    // Approvals reach the owner through the registered notifiers ONLY: Slack
    // Approve/Deny buttons (slack.js) + the email approval with mailto buttons
    // (graph.js). We do NOT also call notifyOwner here — notifyOwner now emails
    // (channels/notify.js), and the email-approval notifier already emails, so
    // doing both double-sent every approval. The notifiers are the one path.
    for (const n of notifiers) {
      try { n({ code, action: actionDescription, thread }); } catch { /* a broken notifier must never block */ }
    }
  }
  return { code, instruction: `Reply "YES ${code}" to confirm or "NO ${code}" to cancel.`, throttled };
}

/**
 * Resolve a pending approval by code. On approval, dispatches to the registered
 * handler for its kind and returns the result.
 * @returns {Promise<{found:boolean, approved?:boolean, action?:string, result?:string, error?:string}>}
 */
export async function resolveByCode(code, approved, { now = Date.now() } = {}) {
  const key = String(code || "").toUpperCase();
  const pending = await loadPending(now);
  const entry = pending.get(key);
  if (!entry) return { found: false };
  pending.delete(key);
  await savePending(pending);
  await recordResolved(key, entry, approved, now); // so a duplicate reply is "already handled", not "unknown"
  if (!approved) return { found: true, approved: false, action: entry.action };
  const handler = handlers.get(entry.kind);
  if (!handler) return { found: true, approved: true, action: entry.action, error: `no handler for "${entry.kind}"` };
  try {
    const result = await handler(entry.params);
    return { found: true, approved: true, action: entry.action, result: result || "Done." };
  } catch (err) {
    log.error("approved action failed", { reason: err.message, kind: entry.kind });
    return { found: true, approved: true, action: entry.action, error: err.message };
  }
}

/**
 * SMS path: if the message is a "YES <code>" / "NO <code>" reply, resolve it
 * (running the staged action on YES) and return a result to relay to the family.
 * `handled:false` means it was not an approval reply (normal routing continues).
 *
 * Handles three reply shapes, all of which Lloyd's own approval prompt offers:
 *   - "YES <code>"                    single approval (the original path)
 *   - "YES <code>, <code>, <code>"    a comma-separated batch
 *   - "YES ALL"                       every code from THIS thread still pending
 *
 * CRITICAL: once a reply is recognized as an approval (has yes/no intent AND either
 * a code or "all"), it is ALWAYS consumed (`handled:true`) -- even when it resolves
 * nothing. A reply that fell through to the orchestrator got the quoted approval
 * thread re-ingested as a new task, which re-created the whole batch and re-prompted
 * -> an amplifying loop (this is what hosed the Woodbury holiday calendar). Consuming
 * it here is the one place that loop is cut.
 * @returns {Promise<{handled:boolean, message?:string}>}
 */
export async function tryResolveConfirmation(messageBody, { now = Date.now() } = {}) {
  const raw = String(messageBody || "");
  // Strip quoted history / signature so an EMAIL reply ("YES 1234" above a quoted
  // thread, "On ... wrote:", "----", or "> ...") still parses as an approval.
  const head = raw.split(/\n\s*>|\nOn\b.+\bwrote:|\n-{2,}|\n_{2,}|\nSent from /i)[0].trim();
  // Approval replies are short. A long prose message that merely happens to
  // contain "yes" + a token is NOT an approval -> let it route normally.
  if (!head || head.length > 200) return { handled: false };

  const affirm = /\b(yes|yep|yeah|approve[d]?|confirm(?:ed)?|ok|okay|go ahead|do it|send it)\b/i.test(head);
  const negate = /\b(no|nope|deny|denied|cancel(?:led)?|don'?t|do not|stop|reject)\b/i.test(head);
  if (!affirm && !negate) return { handled: false }; // no yes/no intent -> normal routing

  // 6-hex code tokens (codes are uppercase hex). Tolerates punctuation/extra words.
  const codesIn = (s) => [...new Set([...String(s).matchAll(/\b([0-9a-f]{6})\b/gi)].map((m) => m[1].toUpperCase()))];
  const isAll = /\ball\b/i.test(head);
  const headCodes = codesIn(head);
  // Bare "yes"/"no" with no code and no "all" is conversational ("yes please book
  // the dentist") -> route to the chief normally, exactly as before.
  if (!isAll && headCodes.length === 0) return { handled: false };

  if (affirm && negate) {
    const which = headCodes[0] ? ` for code ${headCodes[0]}` : "";
    return { handled: true, message: `Did you mean yes or no${which}? Reply "YES <code>" to confirm or "NO <code>" to cancel.` };
  }

  // Which codes to act on. "ALL" is scoped to codes quoted in THIS reply that are
  // still pending, so a blanket yes can never approve an unrelated pending action
  // (e.g. a grocery order sitting in the queue).
  let targetCodes = headCodes;
  if (isAll) {
    const pending = await loadPending(now);
    const inThread = new Set(codesIn(raw));
    const scoped = [...pending.keys()].filter((c) => inThread.has(c));
    // If nothing in the thread pins it (no quoted codes survived), fall back to
    // every pending code -- the user explicitly said "all".
    targetCodes = scoped.length ? scoped : [...pending.keys()];
  }

  if (targetCodes.length === 0) {
    // "ALL" but nothing pending: a duplicate reply after the batch already went
    // through, or it expired. Reassure, never alarm; still consumed (no fallthrough).
    const resolved = await loadResolved(now);
    if (codesIn(raw).some((c) => resolved.has(c))) {
      return { handled: true, message: `You're all set -- I already handled those. No need to approve again.` };
    }
    return { handled: true, message: `I don't see anything pending to ${affirm ? "approve" : "cancel"} right now -- it was likely already handled or expired. Just ask me to redo it if you need it.` };
  }

  const results = [];
  for (const code of targetCodes) results.push({ code, res: await resolveByCode(code, affirm, { now }) });

  // Single code: keep the original, specific phrasing (and existing tests).
  if (results.length === 1) {
    const { code, res } = results[0];
    if (!res.found) {
      const prior = (await loadResolved(now)).get(code);
      if (prior) return { handled: true, message: prior.approved === false
        ? `You're all set -- ${code} was already cancelled a moment ago, nothing more to do.`
        : `You're all set -- I already handled ${code} (${prior.action}). No need to approve again.` };
      return { handled: true, message: `I don't have a pending action for code ${code} -- it was likely already handled or has expired. Nothing to worry about; just ask me to redo it if you need it.` };
    }
    if (!affirm) return { handled: true, message: `Cancelled: ${res.action}` };
    if (res.error) return { handled: true, message: `I tried, but it failed: ${res.error}` };
    return { handled: true, message: res.result };
  }

  // Batch: summarize instead of dumping every result line.
  const ran = results.filter((r) => r.res.found && r.res.approved && !r.res.error).length;
  const cancelled = results.filter((r) => r.res.found && r.res.approved === false).length;
  const failed = results.filter((r) => r.res.error);
  const missing = results.filter((r) => !r.res.found).length;
  const parts = [affirm ? `Approved ${ran} of ${targetCodes.length}.` : `Cancelled ${cancelled} of ${targetCodes.length}.`];
  if (missing) parts.push(`${missing} were already handled or expired.`);
  if (failed.length) parts.push(`${failed.length} failed: ${failed.map((f) => f.res.error).join("; ").slice(0, 160)}`);
  return { handled: true, message: parts.join(" ") };
}
