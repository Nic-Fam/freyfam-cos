// Local headless browser automation (Playwright). Per the topology note, browser
// automation runs LOCALLY on Lloyd's host, never in the Azure specialists. Two
// reasons it stays local: Playwright needs a real browser binary (not friendly to
// serverless scale-to-zero), and any purchase is a high-stakes outbound action
// that must pass Lloyd's confirmation gate + guard before it runs.
//
// HARD CONSTRAINTS honored here:
//   - assertOutboundAllowed() runs before any *action* (order) path, so a browser
//     action can never reach a read-only work domain (flyerdefense / disney).
//   - This module never confirms anything itself. The human-in-the-loop gate
//     (confirm.js) is applied by the tool layer in orchestrator.js, exactly like
//     send_email: the chief owns the gate; this module is the pure capability.
//
// Playwright is an OPTIONAL dependency. It is imported lazily so the daemon, the
// test suite, and every non-browser path keep working when it is not installed.
// Install with: npm i playwright && npx playwright install chromium

import { assertOutboundAllowed } from "../guards.js";

let _browser = null; // shared headless chromium, launched on first use
let _chromium = null;

async function chromium() {
  if (_chromium) return _chromium;
  try {
    ({ chromium: _chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "Browser automation needs Playwright. Run: npm i playwright && npx playwright install chromium"
    );
  }
  return _chromium;
}

async function browser() {
  if (_browser && _browser.isConnected()) return _browser;
  const c = await chromium();
  _browser = await c.launch({ headless: true });
  return _browser;
}

/** Close the shared browser if one is open. Safe to call when nothing launched. */
export async function closeBrowser() {
  if (!_browser) return;
  try {
    await _browser.close();
  } catch {
    /* already gone */
  }
  _browser = null;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

/**
 * READ-ONLY: open a page and return its title plus visible text. No clicks, no
 * form fills, no navigation past the one URL. Safe to call without confirmation.
 * Used for price / listing / availability checks (e.g. resale saved-search hits).
 * @param {string} url
 * @param {{maxChars?:number, timeoutMs?:number}} [opts]
 */
export async function readPage(url, { maxChars = 4000, timeoutMs = 30000 } = {}) {
  hostOf(url); // validate before launching anything
  const b = await browser();
  const page = await b.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const title = await page.title();
    const text = (await page.evaluate(() => document.body?.innerText || "")).trim();
    return { url, title, text: text.slice(0, maxChars), truncated: text.length > maxChars };
  } finally {
    await page.close();
  }
}

const STEP_RUNNERS = {
  goto: async (page, step, timeout) => {
    assertOutboundAllowed(hostOf(step.url)); // re-check on every navigation
    await page.goto(step.url, { waitUntil: "domcontentloaded", timeout });
    return `goto ${step.url}`;
  },
  click: async (page, step, timeout) => {
    await page.click(step.selector, { timeout });
    return `click ${step.selector}`;
  },
  fill: async (page, step, timeout) => {
    await page.fill(step.selector, String(step.value ?? ""), { timeout });
    return `fill ${step.selector}`;
  },
  waitFor: async (page, step, timeout) => {
    await page.waitForSelector(step.selector, { timeout });
    return `waitFor ${step.selector}`;
  },
};

/**
 * HIGH-STAKES ACTION: drive a checkout / order flow. This is the seam the chief
 * wraps in confirm.js before calling. It re-checks the guard here as defense in
 * depth: a browser action may NEVER act on a read-only work domain.
 *
 * `steps` is an ordered list of primitive actions run against the page:
 *   { action: "goto", url }
 *   { action: "click", selector }
 *   { action: "fill", selector, value }
 *   { action: "waitFor", selector }
 * Returns a short transcript so the caller can report what actually happened.
 * @param {{url:string, steps?:Array<object>, timeoutMs?:number}} input
 */
export async function runOrder({ url, steps = [], timeoutMs = 30000 } = {}) {
  if (!url) throw new Error("url is required");
  assertOutboundAllowed(hostOf(url)); // hard constraint, before any browser launch
  const b = await browser();
  const page = await b.newPage();
  const transcript = [];
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    transcript.push(`goto ${url}`);
    for (const step of steps) {
      const run = STEP_RUNNERS[step.action];
      if (!run) throw new Error(`Unknown browser step: ${step.action}`);
      transcript.push(await run(page, step, timeoutMs));
    }
    return { ok: true, finalUrl: page.url(), transcript };
  } finally {
    await page.close();
  }
}
