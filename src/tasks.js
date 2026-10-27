import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// ===========================================================================
// Family to-do list (ported from the legacy assistant, simplified to the COS
// local-store pattern instead of Microsoft To Do / Graph). A real home for the
// family's open tasks — the gap that forced the "open task" workaround into
// memory. Tasks have an optional dueDate (YYYY-MM-DD) and an optional owner.
// ===========================================================================

const STORE_PATH = () => process.env.TASKS_PATH || "./data/tasks.json";
const TZ = process.env.FAMILY_TZ || "America/Los_Angeles";

async function load() {
  try {
    const d = JSON.parse(await readFile(STORE_PATH(), "utf8"));
    return Array.isArray(d.items) ? d : { items: [] };
  } catch {
    return { items: [] };
  }
}
async function save(db) {
  await mkdir(dirname(STORE_PATH()), { recursive: true });
  await writeFile(STORE_PATH(), JSON.stringify(db, null, 2));
}

/** Today's date (YYYY-MM-DD) in the family timezone. */
export function todayLocal(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const normTitle = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const DEDUP_DONE_MS = Number(process.env.TASK_DEDUP_DAYS || 30) * 864e5;

// --- follow-up identity (2026-10-26) ---------------------------------------
// The digest re-derives follow-ups from yesterday's calendar every morning and the
// model words them differently each day ("Follow up: email Deborah re: Fairview
// tour" vs "Follow up with Deborah about the Fairview tour"), so exact-title dedup
// let a closed follow-up come back as a new open task. Two stronger keys now:
//   - `source`: the calendar event a follow-up came from ("<subject> @ <date>"),
//     matched across ANY status for 120 days: once a follow-up for that event
//     existed, it is never recreated.
//   - significant-word overlap for follow-ups, so a rewording still matches.
const FOLLOW_UP_RE = /^\s*follow[- ]?up\b/i;
const STOP = new Set("follow up re about with for the and a an to of on at in by from her his their them him she he it this that email call text reply respond response".split(" "));
const sigWords = (s) => [...new Set((String(s || "").toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w)))];
export const normSource = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9@]+/g, " ").trim();
const SOURCE_WINDOW_MS = 120 * 864e5;

/** Do two follow-up titles describe the same thing? Pure. */
export function sameFollowUp(a, b) {
  const wa = sigWords(a), wb = sigWords(b);
  if (wa.length < 2 || wb.length < 2) return false;
  const shared = wa.filter((w) => wb.includes(w)).length;
  return shared / Math.min(wa.length, wb.length) >= 0.6;
}

const recent = (x, now) => {
  const at = Date.parse(x.completedAt || x.droppedAt || "");
  return Number.isFinite(at) && now - at < DEDUP_DONE_MS;
};

/** Add a task. dueDate optional (YYYY-MM-DD), owner optional, source optional
 *  (the calendar event a follow-up came from). Returns the task (tagged
 *  `deduped:true` if an equivalent one already exists). */
export async function addTask({ title, dueDate = null, owner = null, source = null } = {}, now = Date.now()) {
  const t = String(title || "").trim();
  if (!t) throw new Error("task title is required");
  const db = await load();
  const src = source ? normSource(source) : null;
  const isFollowUp = FOLLOW_UP_RE.test(t) || Boolean(src);
  // Idempotency: don't recreate a task that's already OPEN, or one COMPLETED or
  // DROPPED recently. The morning digest re-derives follow-ups from past events
  // every day; without this it resurrects an already-handled follow-up as a fresh
  // (overdue) duplicate — the "closed items showing overdue" bug.
  const dup =
    (src && db.items.find((x) => x.source && normSource(x.source) === src && now - Date.parse(x.createdAt || 0) < SOURCE_WINDOW_MS)) ||
    db.items.find((x) => normTitle(x.title) === normTitle(t) && (x.status === "open" || recent(x, now))) ||
    (isFollowUp && db.items.find((x) =>
      (x.kind === "follow-up" || FOLLOW_UP_RE.test(x.title)) && (x.status === "open" || recent(x, now)) && sameFollowUp(x.title, t)));
  if (dup) return { ...dup, deduped: true };
  const task = {
    id: randomUUID().slice(0, 8),
    title: t,
    dueDate: dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null,
    owner: owner || null,
    status: "open",
    createdAt: new Date(now).toISOString(),
    ...(isFollowUp ? { kind: "follow-up" } : {}),
    ...(src ? { source: String(source).trim() } : {}),
  };
  db.items.push(task);
  await save(db);
  return task;
}

// Find a task by id (exact/prefix), exact title, or — for a natural "done <phrase>"
// reply — an UNAMBIGUOUS keyword match (the phrase is contained in exactly one open
// task's title, or vice versa). Open tasks preferred. Returns undefined if none, or
// null if the phrase is ambiguous (matches >1 open task) so the caller can ask which.
function find(items, match, now = Date.now(), snapshot = null) {
  const m = String(match || "").trim().replace(/^#/, "");
  const open = items.filter((t) => t.status === "open");
  // Numeric index ("done 2"). When the family is answering a numbered list we
  // SENT (the digest, list_tasks), resolve against that list's saved snapshot, not
  // the live list: the live list re-sorts as tasks are added/closed during the day,
  // and the digest only shows some tasks. Without a snapshot, the Nth open task in
  // the live sorted order. 1-2 digits only, so it can't hijack an all-digit id.
  if (/^\d{1,2}$/.test(m)) {
    if (snapshot && Array.isArray(snapshot.ids)) {
      const id = snapshot.ids[Number(m) - 1];
      return id ? open.find((t) => t.id === id) : undefined;
    }
    return [...open].sort(byDue(now))[Number(m) - 1];
  }
  const nm = normTitle(m);
  const exact =
    open.find((t) => t.id === m) ||
    open.find((t) => t.id.startsWith(m) && m.length >= 4) ||
    open.find((t) => normTitle(t.title) === nm);
  if (exact) return exact;
  if (nm.length >= 4) {
    const hits = open.filter((t) => normTitle(t.title).includes(nm) || nm.includes(normTitle(t.title)));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null; // ambiguous — don't guess which to close
  }
  return items.find((t) => t.id === m);
}

/** Mark a task done by id/prefix/title. Returns the task or null. */
export async function completeTask(match, now = Date.now(), { snapshot = null } = {}) {
  const r = await closeTasks([match], { now, snapshot });
  return r.closed[0] || null;
}

/**
 * Close several tasks at once ("done 1 and 3"), resolving EVERY reference before
 * changing anything, so closing item 1 can't shift what "3" means (the old
 * sequential complete_task calls closed the wrong task). `outcome` "done" or
 * "dropped" (no longer needed). Returns {closed, missing, ambiguous}.
 */
export async function closeTasks(matches = [], { now = Date.now(), snapshot = null, outcome = "done", reason = null } = {}) {
  const db = await load();
  const closed = [], missing = [], ambiguous = [];
  const targets = [];
  for (const m of matches) {
    const task = find(db.items, m, now, snapshot);
    if (task === null) ambiguous.push(String(m));
    else if (!task || task.status !== "open") missing.push(String(m));
    else if (!targets.includes(task)) targets.push(task);
  }
  const at = new Date(now).toISOString();
  for (const task of targets) {
    if (outcome === "dropped") {
      task.status = "dropped";
      task.droppedAt = at;
      if (reason) task.dropReason = reason;
    } else {
      task.status = "done";
      task.completedAt = at;
    }
    closed.push(task);
  }
  if (closed.length) await save(db);
  return { closed, missing, ambiguous };
}

/** Mark a task no longer needed (distinct from done). Returns the task or null. */
export async function dropTask(match, { now = Date.now(), snapshot = null, reason = null } = {}) {
  const r = await closeTasks([match], { now, snapshot, outcome: "dropped", reason });
  return r.closed[0] || null;
}

// --- numbered-list snapshots ------------------------------------------------
// Every numbered task list we send (the digest's to-do section, list_tasks) is
// saved with the exact task ids in the order shown, so "done 2" means the 2nd
// item of the list the family was looking at.
const SNAP_PATH = () => process.env.TASK_SNAPSHOTS_PATH || "./data/task-snapshots.json";
const SNAP_MAX_AGE_MS = Number(process.env.TASK_SNAPSHOT_MAX_DAYS ?? 3) * 864e5;

export async function saveTaskSnapshot(ids, { source = "list", now = Date.now() } = {}) {
  let snaps = [];
  try { snaps = JSON.parse(await readFile(SNAP_PATH(), "utf8")); } catch { snaps = []; }
  if (!Array.isArray(snaps)) snaps = [];
  snaps.push({ at: new Date(now).toISOString(), source, ids: ids.map(String) });
  snaps = snaps.slice(-10);
  await mkdir(dirname(SNAP_PATH()), { recursive: true });
  await writeFile(SNAP_PATH(), JSON.stringify(snaps, null, 2));
}

/** Most recent numbered list sent within the window, or null. */
export async function latestTaskSnapshot({ now = Date.now() } = {}) {
  try {
    const snaps = JSON.parse(await readFile(SNAP_PATH(), "utf8"));
    const last = Array.isArray(snaps) ? snaps[snaps.length - 1] : null;
    if (!last || now - Date.parse(last.at) > SNAP_MAX_AGE_MS) return null;
    return last;
  } catch {
    return null;
  }
}

/**
 * Stable numbering for the day (2026-10-26). The digest fixes the numbers each
 * morning; any later list (list_tasks) REUSES them and appends tasks added since
 * at the end, so "done 3" means the same task in every list Lloyd has shown, and a
 * list Lloyd pulls for his own reasoning can't renumber what the family is reading.
 * Closed tasks keep their slot (numbers never shift). Returns the open tasks with
 * their numbers, and saves the extended snapshot when it grew.
 * @returns {Promise<Array<{n:number, task:object}>>}
 */
export async function currentNumbering({ now = new Date() } = {}) {
  const open = await listTasks({}, now);
  const snap = await latestTaskSnapshot({ now: now.getTime() });
  const ids = snap ? [...snap.ids] : [];
  let grew = !snap;
  for (const t of open) {
    if (!ids.includes(t.id)) { ids.push(t.id); grew = true; }
  }
  if (grew && ids.length) await saveTaskSnapshot(ids, { source: snap ? "extended" : "list", now: now.getTime() });
  const byId = new Map(open.map((t) => [t.id, t]));
  return ids.map((id, i) => ({ n: i + 1, task: byId.get(id) })).filter((e) => e.task);
}

/** Render numbered entries (from currentNumbering) like formatTasks. Pure. */
export function formatNumbered(entries, now = new Date()) {
  if (!entries || !entries.length) return "No open tasks.";
  const today = todayLocal(now);
  return entries
    .map(({ n, task: t }) => {
      let when = "";
      if (t.dueDate && t.dueDate < today) when = ` (OVERDUE, due ${t.dueDate})`;
      else if (t.dueDate === today) when = " (due today)";
      else if (t.dueDate) when = ` (due ${t.dueDate})`;
      const who = t.owner ? ` [${t.owner}]` : "";
      return `${n}. ${t.title}${when}${who} {${t.id}}`;
    })
    .join("\n");
}

// --- deterministic "done N" replies ------------------------------------------
const DONE_VERBS = "done|did|finished|complete|completed|cleared|clear|handled|check(?:ed)? off|close|closed";
const DROP_VERBS = "drop|dropped|skip|skipped|not needed|no longer needed|remove|removed|nvm|never ?mind|cancel|cancelled|canceled";
const NUMS = "(?:#?\\d{1,2})(?:\\s*(?:,|and|&|\\+|\\s)\\s*#?\\d{1,2})*";
const VERB_FIRST = new RegExp(`^(${DONE_VERBS}|${DROP_VERBS})\\s*[:#-]?\\s*(${NUMS}|all)\\s*[.!]*$`, "i");
const NUMS_FIRST = new RegExp(`^(${NUMS}|all)\\s*(?:is|are|=|-)?\\s*(${DONE_VERBS}|${DROP_VERBS})\\s*[.!]*$`, "i");

/**
 * Parse a short numbered-list reply: "done 2", "done 1, 3 and 4", "#2 done",
 * "drop 4", "not needed 3", "done all". Quoted history below the reply is ignored.
 * Returns {outcome:"done"|"dropped", numbers:number[], all:boolean} or null when the
 * message is anything else (it then goes to Lloyd as normal). Pure.
 */
export function parseDoneReply(text) {
  const head = String(text || "")
    .split(/\n\s*>|\nOn\b.+\bwrote:|\n-{2,}|\n_{2,}|\nSent from /i)[0]
    .trim()
    .split(/\n/)[0]
    .trim();
  if (!head || head.length > 60) return null;
  let verb, nums;
  let m = head.match(VERB_FIRST);
  if (m) { verb = m[1]; nums = m[2]; }
  else if ((m = head.match(NUMS_FIRST))) { nums = m[1]; verb = m[2]; }
  else return null;
  const outcome = new RegExp(`^(${DROP_VERBS})$`, "i").test(verb.trim()) ? "dropped" : "done";
  if (/^all$/i.test(nums.trim())) return { outcome, numbers: [], all: true };
  const numbers = [...new Set((nums.match(/\d{1,2}/g) || []).map(Number))].filter((n) => n >= 1);
  return numbers.length ? { outcome, numbers, all: false } : null;
}

/**
 * Close the tasks a "done N" reply refers to, against the latest numbered list we
 * sent. Returns {handled:false} when the text isn't such a reply, else
 * {handled:true, message}. No model call.
 */
export async function tryResolveDoneReply(text, { now = Date.now() } = {}) {
  const parsed = parseDoneReply(text);
  if (!parsed) return { handled: false };
  const snapshot = await latestTaskSnapshot({ now });
  const refs = parsed.all
    ? (snapshot ? snapshot.ids.map((_, i) => String(i + 1)) : [])
    : parsed.numbers.map(String);
  if (!refs.length) return { handled: true, message: "I don't have a recent numbered list to match that against. Tell me the item by name and I'll close it." };
  const r = await closeTasks(refs, { now, snapshot, outcome: parsed.outcome, reason: parsed.outcome === "dropped" ? "family said not needed" : null });
  const verb = parsed.outcome === "dropped" ? "Dropped" : "Marked done";
  const parts = [];
  if (r.closed.length) {
    const label = (t) => {
      const i = snapshot ? snapshot.ids.indexOf(t.id) : -1;
      return `${i >= 0 ? `${i + 1}. ` : ""}${t.title}`;
    };
    parts.push(`${verb}: ${r.closed.map(label).join("; ")}.`);
  }
  if (r.missing.length) parts.push(`Already closed or not on the list: ${r.missing.join(", ")}.`);
  if (!parts.length) parts.push("Nothing matched those numbers; they may already be closed.");
  return { handled: true, message: parts.join(" "), closed: r.closed };
}

// --- aging --------------------------------------------------------------------
// A follow-up nobody answers used to show as OVERDUE forever. After 7 days the
// digest asks once whether it's still needed; after 14 days it is dropped (kept in
// the store, marked dropped, so it can't be recreated either). Only follow-ups age
// out; tasks the family added themselves stay until they say otherwise.
export const ASK_AFTER_DAYS = Number(process.env.FOLLOWUP_ASK_DAYS ?? 7);
export const DROP_AFTER_DAYS = Number(process.env.FOLLOWUP_DROP_DAYS ?? 14);

function ageDays(t, now) {
  const ref = t.dueDate ? Date.parse(`${t.dueDate}T12:00:00Z`) : Date.parse(t.createdAt || "");
  return Number.isFinite(ref) ? Math.floor((now - ref) / 864e5) : 0;
}
const isFollowUpTask = (t) => t.kind === "follow-up" || FOLLOW_UP_RE.test(t.title || "");

/** Drop follow-ups past DROP_AFTER_DAYS. Returns the dropped tasks. */
export async function ageFollowUps({ now = Date.now() } = {}) {
  const db = await load();
  const dropped = [];
  for (const t of db.items) {
    if (t.status === "open" && isFollowUpTask(t) && ageDays(t, now) >= DROP_AFTER_DAYS) {
      t.status = "dropped";
      t.droppedAt = new Date(now).toISOString();
      t.dropReason = `aged out after ${DROP_AFTER_DAYS} days with no reply`;
      dropped.push(t);
    }
  }
  if (dropped.length) await save(db);
  return dropped;
}

/**
 * The digest's to-do section, rendered in CODE (not by the model) and saved as a
 * snapshot, so the numbers the family sees are exactly the numbers "done N"
 * resolves. Shows overdue, due today, due within 3 days, and every open follow-up.
 * Returns {text, ids, dropped}; text is "" when there is nothing to show.
 */
export async function digestTaskSection({ now = new Date(), save: persist = true } = {}) {
  const nowMs = now.getTime();
  const dropped = await ageFollowUps({ now: nowMs });
  const today = todayLocal(now);
  const soon = todayLocal(new Date(nowMs + 3 * 864e5));
  const shown = (await listTasks({}, now)).filter((t) =>
    (t.dueDate && t.dueDate <= soon) || isFollowUpTask(t));
  if (!shown.length) {
    return { text: dropped.length ? `Dropped as stale (no reply in ${DROP_AFTER_DAYS} days): ${dropped.map((t) => t.title).join("; ")}.` : "", ids: [], dropped };
  }
  const lines = shown.map((t, i) => {
    let when = "";
    if (t.dueDate && t.dueDate < today) when = ` (overdue since ${t.dueDate})`;
    else if (t.dueDate === today) when = " (due today)";
    else if (t.dueDate) when = ` (due ${t.dueDate})`;
    const who = t.owner ? ` [${t.owner}]` : "";
    const stale = isFollowUpTask(t) && ageDays(t, nowMs) >= ASK_AFTER_DAYS ? " Still needed? If not, reply 'drop " + (i + 1) + "'." : "";
    return `${i + 1}. ${t.title}${when}${who}${stale}`;
  });
  if (persist) await saveTaskSnapshot(shown.map((t) => t.id), { source: "digest", now: nowMs });
  const tail = "To clear any of these, reply 'done 2' (or 'done 1, 3'). Reply 'drop 2' if one isn't needed anymore.";
  const droppedNote = dropped.length ? `\nDropped as stale (no reply in ${DROP_AFTER_DAYS} days): ${dropped.map((t) => t.title).join("; ")}.` : "";
  return { text: `To do:\n${lines.join("\n")}\n${tail}${droppedNote}`, ids: shown.map((t) => t.id), dropped };
}

/** Delete a task by id/prefix/title. Returns the removed task or null. */
export async function removeTask(match) {
  const db = await load();
  const task = find(db.items, match);  // live-list numbering (no snapshot) for deletes
  if (!task) return null;
  db.items = db.items.filter((t) => t.id !== task.id);
  await save(db);
  return task;
}

// Sort comparator: overdue first, then by due date, then undated. Shared by
// listTasks and the numeric-index resolver in find(), so "done 2" maps to the
// SAME 2nd item the numbered digest / list_tasks shows. (function decl = hoisted,
// so find() above can call it.)
function byDue(now = new Date()) {
  const today = todayLocal(now);
  const bucket = (t) => (t.dueDate && t.dueDate < today ? 0 : t.dueDate === today ? 1 : t.dueDate ? 2 : 3);
  return (a, b) => {
    const ba = bucket(a), bb = bucket(b);
    if (ba !== bb) return ba - bb;
    return (a.dueDate || "9999").localeCompare(b.dueDate || "9999");
  };
}

/** Open tasks, sorted: overdue first, then by due date, then undated. */
export async function listTasks({ includeDone = false } = {}, now = new Date()) {
  const db = await load();
  const items = includeDone ? db.items : db.items.filter((t) => t.status === "open");
  return items.sort(byDue(now));
}

/** Human summary, flagging overdue/today. */
export function formatTasks(tasks, now = new Date()) {
  if (!tasks || !tasks.length) return "No open tasks.";
  const today = todayLocal(now);
  return tasks
    .map((t, i) => {
      let when = "";
      if (t.dueDate && t.dueDate < today) when = ` (OVERDUE, due ${t.dueDate})`;
      else if (t.dueDate === today) when = " (due today)";
      else if (t.dueDate) when = ` (due ${t.dueDate})`;
      const who = t.owner ? ` [${t.owner}]` : "";
      const done = t.status === "done" ? "[x] " : "";
      return `${i + 1}. ${done}${t.title}${when}${who} {${t.id}}`;
    })
    .join("\n");
}
