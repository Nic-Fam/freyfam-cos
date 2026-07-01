// Weekly Amazon spend digest (Patrick's beat). Sunday evening: crawl the local
// Amazon order history, summarize the week's spend + delivery status, and send
// the owner a deterministic (no-model) report. Scheduling mirrors the weekly
// finance report; delivery is Slack + email via notifyOwner (Twilio is retired).
//
// Quiet by design: sends nothing when Amazon isn't signed in on the profile
// (no weekly "go sign in" nag) or when nothing was ordered in the window.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { AMAZON_DIGEST } from "./config.js";
import { notifyOwner } from "./channels/notify.js";
import { fetchAmazonOrders } from "./amazon-orders.js";
import { localParts } from "./digest.js";
import { createLogger } from "./log.js";

const log = createLogger("amazon-digest");

const weekdayOf = (localDate) => new Date(`${localDate}T12:00:00Z`).getUTCDay(); // 0 = Sunday
const parseMoney = (s) => {
  const n = Number(String(s || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** Run now? Configured weekday, in the evening window, once per day. */
export function shouldRunAmazonDigest(now, lastRunDate, cfg = AMAZON_DIGEST) {
  const { weekday = 0, hour = 19, windowHours = 3, tz = "America/Los_Angeles" } = cfg;
  const { date, hour: h } = localParts(now, tz);
  const onDay = weekdayOf(date) === weekday;
  const inWindow = h >= hour && h < hour + windowHours;
  return { run: onDay && inWindow && lastRunDate !== date, date };
}

// Persisted once-per-week guard (survives restarts), same pattern as the digests.
const statePath = () => process.env.AMAZON_DIGEST_STATE_PATH || "./data/amazon-digest-state.json";
export async function getLastAmazonDigestDate() {
  try { return JSON.parse(await readFile(statePath(), "utf8")).lastRunDate || null; } catch { return null; }
}
export async function setLastAmazonDigestDate(date) {
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify({ lastRunDate: date }, null, 2));
}

/**
 * Summarize orders into the week's spend + status. Pure. Orders whose placedDate
 * parses OUTSIDE the window are dropped; undated orders are kept (the crawl is
 * recent-first, so an unparsed date is almost certainly in-window).
 * @returns {{count, total, byStatus, arriving, consumables, sinceDays}}
 */
export function summarizeOrders(orders = [], { now = new Date(), sinceDays = 7 } = {}) {
  const cutoff = now.getTime() - sinceDays * 24 * 60 * 60 * 1000;
  const inWindow = orders.filter((o) => {
    const t = o.placedDate ? Date.parse(o.placedDate) : NaN;
    return Number.isNaN(t) ? true : t >= cutoff;
  });
  const total = inWindow.reduce((s, o) => s + parseMoney(o.total), 0);
  const byStatus = {};
  for (const o of inWindow) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const arriving = inWindow.filter((o) => o.status === "arriving" || o.status === "shipped");
  const consumables = inWindow.flatMap((o) => (o.items || []).filter((i) => i.consumable).map((i) => i.title));
  return { count: inWindow.length, total: Math.round(total * 100) / 100, byStatus, arriving, consumables, sinceDays };
}

/** Compose the digest text from a summary. Pure. Returns {subject, text}. */
export function composeAmazonDigest(summary) {
  const { count, total, byStatus, arriving, consumables, sinceDays } = summary;
  const subject = `Amazon spend: ${count} order${count === 1 ? "" : "s"}, $${total.toFixed(2)} (last ${sinceDays}d)`;
  const statusLine = Object.entries(byStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  const lines = [`Amazon, last ${sinceDays} days: ${count} order${count === 1 ? "" : "s"}, $${total.toFixed(2)} total.`];
  if (statusLine) lines.push(`Status: ${statusLine}.`);
  if (arriving.length) {
    lines.push(`Still coming (${arriving.length}):`);
    for (const o of arriving.slice(0, 8)) {
      const first = o.items?.[0]?.title ? ` - ${o.items[0].title.slice(0, 60)}` : "";
      lines.push(`  ${o.deliveryLine || o.status}${first}`);
    }
  }
  if (consumables.length) {
    const uniq = [...new Set(consumables)].slice(0, 10);
    lines.push(`Consumables/pantry (for Carmine): ${uniq.join("; ")}`);
  }
  return { subject, text: lines.join("\n") };
}

/**
 * Crawl, summarize, and deliver to the owner. Injectable deps for tests.
 * Sends nothing when not signed in or when the window has no orders.
 * @returns {{sent, signedIn, count?}}
 */
export async function runAmazonDigest({ fetch = fetchAmazonOrders, notify = notifyOwner, now = new Date(), cfg = AMAZON_DIGEST } = {}) {
  const res = await fetch({ pages: cfg.pages });
  if (!res || !res.signedIn) {
    log.info("amazon digest skipped: not signed in");
    return { sent: false, signedIn: false };
  }
  const summary = summarizeOrders(res.orders || [], { now, sinceDays: cfg.sinceDays });
  if (!summary.count) return { sent: false, signedIn: true, count: 0 };
  const { text } = composeAmazonDigest(summary);
  await notify(text);
  return { sent: true, signedIn: true, count: summary.count };
}
