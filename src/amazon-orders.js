import { withPage } from "./channels/browser.js";
import { createLogger } from "./log.js";

const log = createLogger("amazon-orders");

// ===========================================================================
// Read the family's Amazon ORDER HISTORY (status + spend), so Lloyd can hand a
// structured view to finance (Patrick: spend analysis) and chef (Carmine:
// which consumables were ordered + when they land). Read-only — no purchases,
// so no confirmation gate (unlike browser.js runOrder).
//
// Runs on the LOCAL signed-in Chrome profile ONLY (browser.js contract): Amazon
// order history is behind login + heavy bot detection, so it needs the real
// residential, signed-in profile. The Azure specialists have no browser, so
// Lloyd crawls here and delegates the analysis to them — same split as resale's
// browser-only sources.
//
// SLOW CRAWL by design: navigate a page at a time with human-paced gaps and let
// the real profile carry the session. Parsing is TEXT-based (regex over each
// order card's innerText) rather than pinned to Amazon's churning CSS classes,
// so a class rename doesn't silently blank a field. Selectors that DO matter
// (card container, product links) are broad; tune live once signed in.
// ===========================================================================

const ORDERS_URL =
  process.env.AMAZON_ORDERS_URL || "https://www.amazon.com/gp/css/order-history?ref_=nav_orders_first";
// A redirect to any of these means the profile isn't signed in (or hit an MFA/
// captcha challenge) — report that instead of scraping a login page as "orders".
const SIGNIN_RE = /\/ap\/signin|\/ap\/mfa|\/ap\/cvf|signin\?|\/errors\/validateCaptcha/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_GAP_MIN_MS = Number(process.env.AMAZON_PAGE_GAP_MIN_MS ?? 2500);
const PAGE_GAP_MAX_MS = Number(process.env.AMAZON_PAGE_GAP_MAX_MS ?? 6000);
function pageGapMs() {
  const lo = Math.min(PAGE_GAP_MIN_MS, PAGE_GAP_MAX_MS), hi = Math.max(PAGE_GAP_MIN_MS, PAGE_GAP_MAX_MS);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// --- pure parsers (unit-tested) --------------------------------------------

export function isSignInWall(url) {
  return SIGNIN_RE.test(String(url || ""));
}

const MONEY_RE = /\$[\d,]+\.\d{2}/;
const ORDER_ID_RE = /\b(\d{3}-\d{7}-\d{7})\b/;
const DATE_RE = /((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)/;

/** Coarse lifecycle status from a card's text — what finance/chef branch on. */
export function classifyStatus(text) {
  const t = String(text || "").toLowerCase();
  if (/\bcancel(l)?ed\b/.test(t)) return "cancelled";
  if (/\b(return|refund)/.test(t)) return "returned";
  if (/\bdelivered\b/.test(t)) return "delivered";
  if (/\b(out for delivery|arriving|expected|now expected|preparing for dispatch)\b/.test(t)) return "arriving";
  if (/\b(shipped|dispatched|on the way|has shipped)\b/.test(t)) return "shipped";
  if (/\border placed\b|\bordered\b/.test(t)) return "ordered";
  return "unknown";
}

// Heuristic: is this line item a grocery/household CONSUMABLE (chef's beat:
// pantry restock)? Deliberately generous — chef re-checks; a false positive just
// surfaces one extra item. Non-consumables (electronics, clothing) fall through.
const CONSUMABLE_RE = new RegExp(
  [
    "coffee", "tea", "snack", "cereal", "oatmeal", "granola", "pasta", "rice", "flour", "sugar",
    "oil", "vinegar", "sauce", "spice", "seasoning", "protein", "vitamin", "supplement",
    "water", "juice", "soda", "milk", "formula", "diaper", "wipe", "paper towel", "toilet paper",
    "detergent", "soap", "shampoo", "toothpaste", "cleaner", "trash bag", "dish", "napkin",
    "food", "organic", "gluten", "nut", "butter", "honey", "chocolate", "bar\\b",
  ].join("|"),
  "i"
);
export function isConsumable(title) {
  return CONSUMABLE_RE.test(String(title || ""));
}

// Needed vs discretionary (finance's beat), separate from `consumable` (chef's).
// NEEDED wins over DISCRETIONARY when both match (a "kids safety toy lock" is needed).
// GRAY = coffee + optional recurring (a real spend lever, neither strictly needed nor
// a one-off want). Heuristic + generous on "needed" since essentials dominate; the
// unmatched default is "needed" so we under-flag rather than over-flag discretionary.
const NEED_RE = new RegExp(
  ["diaper", "pull-?up", "wipe", "sunscreen", "dog food", "cat food", "pee pad", "litter",
   "detergent", "trash bag", "toothbrush", "toothpaste", "moisturizer", "deodorant", "formula",
   "vitamin", "supplement", "creatine", "batter(y|ies)", "medicine", "first aid", "cold pack",
   "ear ?wax", "safety", "door (lock|lever|knob)", "toilet", "cleaning", "pumice",
   "packing (paper|tape)", "stretch film", "shipping label", "storage (bin|label)", "sticker",
   "regulator", "valve", "bed sheet", "underwear", "potty", "training pants", "dental chew",
   "dog treat", "shampoo", "soap", "napkin", "paper towel", "grocery", "\\bfood\\b"].join("|"),
  "i"
);
const GRAY_RE = /\b(coffee|k-?cups?|keurig|espresso|instant coffee)\b/i;
const DISCRETIONARY_RE = /\b(toy|train (set|track)|basketball|football|soccer ball|board game|video game|puzzle|lego|figure|doll|ice maker|fire tv|tv cube|streaming|echo dot|smart speaker|headphones?|earbuds|owl house|bird house|d[eé]cor|ornament|party favor|novelty|drone|gadget|collectible|candle)\b/i;
export function classifyNeed(title) {
  const t = String(title || "");
  if (NEED_RE.test(t)) return "needed";
  if (GRAY_RE.test(t)) return "gray";
  if (DISCRETIONARY_RE.test(t)) return "discretionary";
  return "needed";
}

/** Roll classified items into a needed/discretionary/gray summary. Pure. */
export function summarizeNeeds(orders = []) {
  const items = [];
  for (const o of orders) for (const it of (o.items || [])) {
    items.push({ title: it.title, need: it.need || classifyNeed(it.title), orderTotal: o.total, date: o.placedDate, orderId: o.orderId });
  }
  const by = (c) => items.filter((x) => x.need === c);
  return {
    itemCount: items.length,
    neededCount: by("needed").length,
    grayCount: by("gray").length,
    discretionary: by("discretionary"),
    gray: by("gray"),
  };
}

/** Parse one scraped order card ({text, items}) into a structured order. Pure. */
export function parseOrderCard({ text = "", items = [] } = {}) {
  const orderId = (text.match(ORDER_ID_RE) || [])[1] || null;
  const total = (text.match(MONEY_RE) || [])[0] || null;
  const placedDate = (text.match(DATE_RE) || [])[1] || null;
  const status = classifyStatus(text);
  // The human-readable delivery line, if any (e.g. "Delivered Jun 28", "Arriving Tuesday").
  const deliveryLine =
    (text.split("\n").map((l) => l.trim()).find((l) =>
      /^(delivered|arriving|out for delivery|now expected|expected|shipped)\b/i.test(l)
    ) || null);
  const cleanItems = (items || [])
    .map((it) => ({ title: String(it.title || "").trim(), href: it.href || null }))
    .filter((it) => it.title)
    .map((it) => ({ ...it, consumable: isConsumable(it.title), need: classifyNeed(it.title) }));
  return { orderId, placedDate, total, status, deliveryLine, items: cleanItems };
}

// --- in-page scrape (runs in the browser; not under node coverage) ----------
/* istanbul ignore next -- executes in page context, not node */
function scrapeCardsInPage() {
  const cards = new Set();
  for (const sel of [".order-card", ".js-order-card", ".order", "[class*='order-card']"]) {
    document.querySelectorAll(sel).forEach((el) => cards.add(el));
  }
  const out = [];
  for (const card of cards) {
    // Skip nested matches (a card inside an already-captured card).
    if ([...cards].some((other) => other !== card && other.contains(card))) continue;
    const text = (card.innerText || "").replace(/\n{2,}/g, "\n").trim();
    const items = [];
    for (const a of card.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')) {
      const title = (a.innerText || a.textContent || "").replace(/\s+/g, " ").trim();
      if (title && title.length > 2) items.push({ title, href: a.getAttribute("href") });
    }
    out.push({ text: text.slice(0, 4000), items: items.slice(0, 20) });
  }
  return out;
}

/**
 * Crawl recent Amazon order history slowly on the local signed-in profile.
 * @returns {Promise<{signedIn:boolean, orders:Array, note?:string, pagesRead:number}>}
 * On a sign-in/captcha wall returns {signedIn:false, orders:[], note} rather than
 * throwing, so Lloyd can tell the family exactly what to fix.
 */
export async function fetchAmazonOrders({ pages = 2, maxOrders = 40, timeoutMs = 45000 } = {}) {
  const wanted = Math.min(Math.max(1, pages), 6); // cap the crawl
  return withPage(async (page) => {
    const orders = [];
    let pagesRead = 0;
    for (let p = 0; p < wanted; p++) {
      const url = p === 0 ? ORDERS_URL : `${ORDERS_URL}${ORDERS_URL.includes("?") ? "&" : "?"}startIndex=${p * 10}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      if (isSignInWall(page.url())) {
        return {
          signedIn: false,
          orders: [],
          pagesRead,
          note:
            "Amazon isn't signed in on the automation Chrome profile (Chrome-cos). Sign into Amazon once in that profile — under the daemon's launch flags — then I can read order history.",
        };
      }
      try {
        await page.waitForSelector(".order-card, .js-order-card, .order, [class*='order-card']", { timeout: 8000 });
      } catch {
        break; // no order cards on this page — end of history or an unexpected layout
      }
      const raw = await page.evaluate(scrapeCardsInPage);
      pagesRead = p + 1;
      if (!raw.length) break;
      for (const c of raw) {
        const o = parseOrderCard(c);
        if (o.orderId || o.items.length) orders.push(o);
        if (orders.length >= maxOrders) break;
      }
      if (orders.length >= maxOrders) break;
      if (p < wanted - 1) await sleep(pageGapMs()); // human-paced gap between pages
    }
    // Dedup by orderId (a card can repeat across page boundaries).
    const seen = new Set();
    const deduped = orders.filter((o) => {
      const k = o.orderId || JSON.stringify(o.items.map((i) => i.title));
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    log.info("amazon order crawl", { pagesRead, orders: deduped.length });
    return { signedIn: true, orders: deduped, pagesRead };
  });
}
