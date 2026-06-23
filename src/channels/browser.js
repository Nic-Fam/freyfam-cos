// Local headless browser automation (Playwright). Per the topology note, browser
// automation runs LOCALLY on Lloyd's host, never in the Azure specialists. Two
// reasons it stays local: Playwright needs a real browser binary (not friendly to
// serverless scale-to-zero), and any purchase is a high-stakes outbound action
// that must pass Lloyd's confirmation gate + guard before it runs.
//
// HARD CONSTRAINT honored here:
//   - This module never confirms anything itself. Any purchase is high-stakes and
//     the human-in-the-loop gate (confirm.js) is applied by the tool layer in
//     orchestrator.js, exactly like send_email: the chief owns the gate; this
//     module is the pure capability. (The old work-domain hard block was removed
//     2026-06-20; the confirmation gate is the protection.)
//
// Playwright is an OPTIONAL dependency. It is imported lazily so the daemon, the
// test suite, and every non-browser path keep working when it is not installed.
// Install with: npm i playwright && npx playwright install chromium

// Launch config. Defaults reproduce the old behavior (ephemeral headless Chromium).
// For real ordering on a family device, point BROWSER_USER_DATA_DIR at that
// device's Chrome profile and set BROWSER_CHANNEL=chrome: Playwright then drives
// the REAL Chrome with its saved logins/passwords (so checkout is already signed
// in) from the device's residential IP. Orders must run on Lloyd's local Mac, never
// an Azure specialist, so the IP is residential (see the topology note above).
const BROWSER = {
  channel: process.env.BROWSER_CHANNEL || null,             // e.g. "chrome" (real Chrome w/ the saved creds)
  userDataDir: process.env.BROWSER_USER_DATA_DIR || null,   // persistent Chrome profile (saved logins/passwords)
  headless: String(process.env.BROWSER_HEADLESS ?? "true").toLowerCase() === "true",
  slowMo: Number(process.env.BROWSER_SLOWMO_MS ?? 0),       // Playwright slowMo on every action
  // Human-like pause between order steps. Default SLOW: orders run in the morning
  // with hours to spare, and slow + a real signed-in profile beats bot detection.
  orderStepMinMs: Number(process.env.ORDER_STEP_MIN_MS ?? 4000),
  orderStepMaxMs: Number(process.env.ORDER_STEP_MAX_MS ?? 9000),
};

let _browser = null;   // ephemeral Browser (no profile configured)
let _context = null;   // persistent BrowserContext (real Chrome profile)
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

// A page from the right surface: the device's persistent Chrome profile when
// configured (saved logins available), else an ephemeral headless Chromium.
async function newPage() {
  const c = await chromium();
  if (BROWSER.userDataDir) {
    if (!_context) {
      _context = await c.launchPersistentContext(BROWSER.userDataDir, {
        channel: BROWSER.channel || "chrome",
        headless: BROWSER.headless,
        slowMo: BROWSER.slowMo,
      });
    }
    return _context.newPage();
  }
  if (!_browser || !_browser.isConnected()) {
    _browser = await c.launch({ headless: BROWSER.headless, slowMo: BROWSER.slowMo, ...(BROWSER.channel ? { channel: BROWSER.channel } : {}) });
  }
  return _browser.newPage();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Randomized human-like pause in [min,max]. Pure-ish; 0 when both are 0.
function humanPauseMs(min = BROWSER.orderStepMinMs, max = BROWSER.orderStepMaxMs) {
  if (!min && !max) return 0;
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** Close the shared browser/context if one is open. Safe when nothing launched. */
export async function closeBrowser() {
  for (const closeable of [_context, _browser]) {
    if (!closeable) continue;
    try { await closeable.close(); } catch { /* already gone */ }
  }
  _context = null;
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
  const page = await newPage();
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
 * wraps in confirm.js before calling (the confirmation gate is the protection).
 *
 * `steps` is an ordered list of primitive actions run against the page:
 *   { action: "goto", url }
 *   { action: "click", selector }
 *   { action: "fill", selector, value }
 *   { action: "waitFor", selector }
 * Returns a short transcript so the caller can report what actually happened.
 * @param {{url:string, steps?:Array<object>, timeoutMs?:number}} input
 */
export async function runOrder({ url, steps = [], timeoutMs = 60000, pace = true } = {}) {
  if (!url) throw new Error("url is required");
  const page = await newPage();
  const transcript = [];
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    transcript.push(`goto ${url}`);
    for (const step of steps) {
      const run = STEP_RUNNERS[step.action];
      if (!run) throw new Error(`Unknown browser step: ${step.action}`);
      // Pace order steps like a human (default slow). Orders run in the morning
      // with hours to spare, so unhurried + a real signed-in Chrome profile is
      // the anti-bot strategy. Set pace:false (or ORDER_STEP_*_MS=0) to disable.
      if (pace) { const ms = humanPauseMs(); if (ms) await sleep(ms); }
      transcript.push(await run(page, step, timeoutMs));
    }
    return { ok: true, finalUrl: page.url(), transcript };
  } finally {
    await page.close();
  }
}
