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

/** Add a task. dueDate optional (YYYY-MM-DD), owner optional. Returns the task
 *  (tagged `deduped:true` if an equivalent one already exists). */
export async function addTask({ title, dueDate = null, owner = null } = {}, now = Date.now()) {
  const t = String(title || "").trim();
  if (!t) throw new Error("task title is required");
  const db = await load();
  // Idempotency: don't recreate a task that's already OPEN, or one COMPLETED
  // recently. The morning digest re-derives follow-ups from past events every day;
  // without this it resurrects an already-handled follow-up as a fresh (overdue)
  // duplicate — the "closed items showing overdue" bug.
  const dup = db.items.find((x) =>
    normTitle(x.title) === normTitle(t) &&
    (x.status === "open" || (x.status === "done" && x.completedAt && now - Date.parse(x.completedAt) < DEDUP_DONE_MS))
  );
  if (dup) return { ...dup, deduped: true };
  const task = {
    id: randomUUID().slice(0, 8),
    title: t,
    dueDate: dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate) ? dueDate : null,
    owner: owner || null,
    status: "open",
    createdAt: new Date(now).toISOString(),
  };
  db.items.push(task);
  await save(db);
  return task;
}

// Find a task by id (exact/prefix), exact title, or — for a natural "done <phrase>"
// reply — an UNAMBIGUOUS keyword match (the phrase is contained in exactly one open
// task's title, or vice versa). Open tasks preferred. Returns undefined if none, or
// null if the phrase is ambiguous (matches >1 open task) so the caller can ask which.
function find(items, match, now = Date.now()) {
  const m = String(match || "").trim();
  const open = items.filter((t) => t.status === "open");
  // Numeric index ("done 2") -> the Nth open task in the SAME order the numbered
  // morning digest / list_tasks shows. Limited to 1-2 digits so it can't collide
  // with an all-digit 8-char task id.
  if (/^\d{1,2}$/.test(m)) return [...open].sort(byDue(now))[Number(m) - 1];
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
export async function completeTask(match, now = Date.now()) {
  const db = await load();
  const task = find(db.items, match, now);
  if (!task) return null;
  task.status = "done";
  task.completedAt = new Date(now).toISOString();
  await save(db);
  return task;
}

/** Delete a task by id/prefix/title. Returns the removed task or null. */
export async function removeTask(match) {
  const db = await load();
  const task = find(db.items, match);
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
