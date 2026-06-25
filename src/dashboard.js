// A deterministic "today" card — schedule, Fox's day, meals, packages, tasks — in
// one glance. Distinct from the morning digest (LLM-composed prose): this is fast,
// cheap (no model tokens), and consistent, for an on-demand "what's today?" or a
// Slack card. The gather is best-effort per source; the formatter is pure/testable.

/** Format the gathered pieces into a compact card. Pure. Empty sections are dropped. */
export function formatDashboard({ dateLabel, events = [], fox = null, meals = [], packages = [], tasks = [] } = {}) {
  const lines = [];
  lines.push(`Today — ${dateLabel || ""}`.trim());

  if (events.length) {
    lines.push("\nSchedule:");
    for (const e of events.slice(0, 8)) lines.push(`- ${e.time ? e.time + " " : ""}${e.title}${e.who ? ` (${e.who})` : ""}`);
  }
  if (fox && (fox.activities || fox.wardrobe)) {
    lines.push("\nFox:");
    if (fox.activities) lines.push(`- ${fox.activities}`);
    if (fox.wardrobe) lines.push(`- Wear: ${fox.wardrobe}`);
  }
  if (meals.length) {
    lines.push("\nMeals:");
    for (const m of meals.slice(0, 6)) lines.push(`- ${m.mealType ? m.mealType + ": " : ""}${m.name}`);
  }
  const overdue = tasks.filter((t) => t.overdue);
  const dueToday = tasks.filter((t) => !t.overdue);
  if (overdue.length || dueToday.length) {
    lines.push("\nTasks:");
    for (const t of overdue.slice(0, 6)) lines.push(`- OVERDUE: ${t.title}`);
    for (const t of dueToday.slice(0, 6)) lines.push(`- ${t.title}`);
  }
  if (packages.length) {
    lines.push("\nArriving:");
    for (const p of packages.slice(0, 6)) lines.push(`- ${p.label || p.carrier || "Package"}${p.eta ? ` (${p.eta})` : ""}`);
  }
  if (lines.length === 1) lines.push("Nothing scheduled — clear day.");
  return lines.join("\n");
}
