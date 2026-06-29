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
import { unlink } from "node:fs/promises";
import { join } from "node:path";

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

// macOS: opening a real Chrome profile otherwise blocks on the Keychain
// "Chrome wants to use confidential information" prompt — with no GUI to answer
// it, the launch hangs forever. --password-store=basic + --use-mock-keychain keep
// cookie/session storage self-contained in the profile. CONSEQUENCE: a profile
// must be signed in UNDER these same flags, or its keychain-encrypted cookies
// won't decrypt and it reads as logged-out. The rest skip first-run UI.
const LAUNCH_ARGS = [
  "--password-store=basic",
  "--use-mock-keychain",
  "--no-first-run",
  "--no-default-browser-check",
  // Drop the navigator.webdriver flag. Login/checkout forms on bot-protected
  // sites (Ralphs/Kroger, TheRealReal) refuse to submit when automation is
  // detected, even on a real click. Paired with ignoreDefaultArgs below.
  "--disable-blink-features=AutomationControlled",
];
// Suppress Playwright's default automation switches (the "controlled by automated
// test software" banner + automation fingerprint) for the same anti-bot reason.
const IGNORE_DEFAULT_ARGS = ["--enable-automation"];
// Fail fast instead of hanging if a profile can't be driven (e.g. a bloated
// everyday profile). Tunable; 0 in Playwright means "no timeout", which we avoid.
const LAUNCH_TIMEOUT_MS = Number(process.env.BROWSER_LAUNCH_TIMEOUT_MS ?? 45000) || 45000;

// A persistent profile left by an unclean exit (the daemon SIGKILLs on shutdown)
// keeps stale Singleton* handoff files; Chrome then tries to hand the launch off
// to a now-dead instance and exits, hanging launchPersistentContext. Clear them
// before launching (best-effort; missing files are fine).
async function clearSingletonLocks(dir) {
  await Promise.all(
    ["SingletonLock", "SingletonCookie", "SingletonSocket"].map((f) =>
      unlink(join(dir, f)).catch(() => {})
    )
  );
}

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
      await clearSingletonLocks(BROWSER.userDataDir);
      _context = await c.launchPersistentContext(BROWSER.userDataDir, {
        channel: BROWSER.channel || "chrome",
        headless: BROWSER.headless,
        slowMo: BROWSER.slowMo,
        args: LAUNCH_ARGS,
        ignoreDefaultArgs: IGNORE_DEFAULT_ARGS,
        timeout: LAUNCH_TIMEOUT_MS,
      });
    }
    return _context.newPage();
  }
  if (!_browser || !_browser.isConnected()) {
    _browser = await c.launch({ headless: BROWSER.headless, slowMo: BROWSER.slowMo, args: LAUNCH_ARGS, ignoreDefaultArgs: IGNORE_DEFAULT_ARGS, timeout: LAUNCH_TIMEOUT_MS, ...(BROWSER.channel ? { channel: BROWSER.channel } : {}) });
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

// Harvest a price from a page's STRUCTURED data, in the page context. These
// signals are site-agnostic — schema.org Product/Offer JSON-LD, OpenGraph/product
// meta tags, and microdata `itemprop=price` are emitted by nearly every resale and
// retail site (verified live on TheRealReal and eBay), so a watcher reads the same
// way everywhere instead of guessing at the "first dollar sign" in visible text.
// Returns {jsonLd, meta, microdata} (numbers or null); watch.js picks among them.
/* istanbul ignore next -- runs in the browser, not under node test coverage */
function priceSignalsInPage() {
  const num = (v) => {
    if (v == null) return null;
    const n = Number(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  let jsonLd = null;
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const j = JSON.parse(s.textContent);
      const nodes = Array.isArray(j) ? j : (j["@graph"] || [j]);
      for (const node of nodes) {
        if (!node) continue;
        const ty = node["@type"];
        if (!/product/i.test(Array.isArray(ty) ? ty.join() : (ty || ""))) continue;
        const off = Array.isArray(node.offers) ? node.offers[0] : (node.offers || {});
        const p = num(off && (off.price != null ? off.price : off.lowPrice));
        if (p != null) { jsonLd = p; break; }
      }
    } catch { /* skip unparseable LD block */ }
    if (jsonLd != null) break;
  }
  const meta = num(
    document.querySelector('meta[property="product:price:amount"]')?.content ||
    document.querySelector('meta[property="og:price:amount"]')?.content
  );
  const ip = document.querySelector('[itemprop="price"]');
  const microdata = num(ip && (ip.getAttribute("content") || ip.textContent));
  return { jsonLd, meta, microdata };
}

/**
 * READ-ONLY: open a page and return its title, visible text, AND structured price
 * signals. No clicks, no form fills, no navigation past the one URL. Safe to call
 * without confirmation. Used for price / listing / availability checks (e.g. resale
 * saved-search hits). `priceSignals` lets a watcher read the price from structured
 * data (works across sites) and fall back to the visible text only as a last resort.
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
    let priceSignals = { jsonLd: null, meta: null, microdata: null };
    try { priceSignals = await page.evaluate(priceSignalsInPage); } catch { /* signals are best-effort */ }
    return { url, title, text: text.slice(0, maxChars), truncated: text.length > maxChars, priceSignals };
  } finally {
    await page.close();
  }
}

/**
 * READ-ONLY: read a product LISTING feed (a grid/new-arrivals page) into structured
 * rows. Cards are identified by their product anchor (`anchorPrefix`); for each
 * unique anchor we climb to the smallest ancestor that still contains only that one
 * anchor (its card) and pull the configured `fields` (a {key: cssSelector} map) from
 * within it. This isolates one card without relying on a stable container class.
 * Verified live on TheRealReal's new-arrivals grid. When signed in (the family's
 * Chrome profile), this is how First Look early-access items surface.
 * @param {string} url
 * @param {{anchorPrefix?:string, fields?:Record<string,string>, max?:number, timeoutMs?:number}} [opts]
 */
export async function readListingFeed(url, { anchorPrefix = "/products/", fields = {}, max = 60, timeoutMs = 30000 } = {}) {
  hostOf(url);
  const page = await newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    // The grid is an SPA that paints async; wait briefly for the first card, but
    // don't fail the run if it never appears (e.g. redirected to a sign-in wall).
    try { await page.waitForSelector(`a[href^="${anchorPrefix}"]`, { timeout: 8000 }); } catch { /* empty feed */ }
    const items = await page.evaluate(({ anchorPrefix, fields, max }) => {
      const byHref = new Map();
      for (const a of document.querySelectorAll(`a[href^="${anchorPrefix}"]`)) {
        const href = a.getAttribute("href");
        if (!href || byHref.has(href)) continue;
        let card = a;
        while (card.parentElement && card.parentElement.querySelectorAll(`a[href^="${anchorPrefix}"]`).length === 1) {
          card = card.parentElement;
        }
        const row = { href };
        for (const k of Object.keys(fields)) {
          const el = card.querySelector(fields[k]);
          row[k] = el ? (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim() : null;
        }
        byHref.set(href, row);
        if (byHref.size >= max) break;
      }
      return [...byHref.values()];
    }, { anchorPrefix, fields, max });
    return { url, finalUrl: page.url(), items };
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
