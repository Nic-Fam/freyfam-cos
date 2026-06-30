import "dotenv/config";
import { withPage, closeBrowser } from "../src/channels/browser.js";

// ===========================================================================
// One-off diagnostic — run on Lloyd's mini to LOCK the resale listing-card
// selectors in src/resale-browser.js. Opens each no-API site's SEARCH RESULTS
// page in the local (ideally signed-in) Chrome and dumps:
//   - a histogram of anchor href path-prefixes (confirm/choose anchorPrefix)
//   - for the configured anchorPrefix, the outerHTML of the first few cards
//   - match counts + sample text for candidate title/price selectors
// Paste the output back to Claude and we set RESALE_SITES fields from real markup.
//
// READ-ONLY: no clicks, no orders. Uses the SAME signed-in Chrome profile as
// ordering/First Look, so search pages are not gated by a login wall.
//
// Usage (on the mini, with the .env that has BROWSER_CHANNEL/BROWSER_USER_DATA_DIR):
//   npm run capture:resale -- "Margiela Tabi"
//   # or directly:
//   BROWSER_CHANNEL=chrome BROWSER_HEADLESS=false \
//   BROWSER_USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome" \
//   node tools/capture-resale-selectors.mjs "Margiela Tabi"
// (Quit Chrome first so Playwright can drive the profile.)
// ===========================================================================

const query = process.argv[2] || "Margiela Tabi";
const SETTLE_MS = Number(process.env.CAPTURE_SETTLE_MS || 2500); // let SPA grids paint

const SITES = [
  {
    key: "therealreal",
    url: (q) => `https://www.therealreal.com/products?keywords=${encodeURIComponent(q)}`,
    anchorPrefix: "/products/",
    candidates: {
      title: ['[data-testid="product-card/description"]', '[data-testid="product-card/brand"]', "[class*='description']"],
      price: ['[data-testid="product-price/final"]', "[class*='price']"],
    },
  },
  {
    key: "poshmark",
    url: (q) => `https://poshmark.com/search?query=${encodeURIComponent(q)}`,
    anchorPrefix: "/listing/",
    candidates: {
      title: ["[class*='title']", "a[class*='title']", "img[alt]"],
      price: ["[class*='price']", "[class*='Price']"],
    },
  },
  {
    key: "depop",
    url: (q) => `https://www.depop.com/search/?q=${encodeURIComponent(q)}`,
    anchorPrefix: "/products/",
    candidates: {
      title: ["img[alt]", "[class*='description']", "p[class*='title']"],
      price: ["[aria-label*='rice']", "p[class*='rice']", "[class*='Price']"],
    },
  },
  {
    key: "grailed",
    url: (q) => `https://www.grailed.com/shop?query=${encodeURIComponent(q)}`,
    anchorPrefix: "/listings/",
    candidates: {
      title: ["[class*='title']", "[class*='ListingMetadata']", "p[class*='designer']"],
      price: ["[class*='price']", "[class*='Price']"],
    },
  },
  // No clean product-link prefix today (Brave fallback in resale-sources.js).
  // Included with anchorPrefix:null so the histogram can REVEAL their real
  // prefix; if one is clean enough we can promote them to a browser source.
  {
    key: "vestiaire",
    url: (q) => `https://www.vestiairecollective.com/search/?q=${encodeURIComponent(q)}`,
    anchorPrefix: null,
    candidates: { title: [], price: [] },
  },
  {
    key: "mytheresa",
    url: (q) => `https://www.mytheresa.com/euw/en/search?q=${encodeURIComponent(q)}`,
    anchorPrefix: null,
    candidates: { title: [], price: [] },
  },
];

// Runs IN THE PAGE (serialized by Playwright — no closures, keep it self-contained).
function inspect({ anchorPrefix, candidates, max }) {
  const trunc = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n);

  // Histogram of href first-segment prefixes, so the product-link path is obvious.
  const counts = {};
  for (const a of document.querySelectorAll("a[href]")) {
    let path = a.getAttribute("href") || "";
    try { path = new URL(path, location.origin).pathname; } catch { /* keep raw */ }
    const seg = "/" + path.split("/").filter(Boolean).slice(0, 1).join("/");
    if (seg && seg !== "/") counts[seg] = (counts[seg] || 0) + 1;
  }
  const histogram = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([prefix, n]) => ({ prefix, n }));

  const result = { url: location.href, title: document.title, histogram, candidateMatches: {}, cards: [] };
  if (!anchorPrefix) return result;

  for (const kind of Object.keys(candidates)) {
    result.candidateMatches[kind] = candidates[kind].map((sel) => {
      let n = 0, sample = null;
      try {
        const els = document.querySelectorAll(sel);
        n = els.length;
        const e = els[0];
        sample = trunc(e && (e.innerText || e.getAttribute("alt") || e.getAttribute("content")), 60);
      } catch { /* invalid selector */ }
      return { sel, n, sample };
    });
  }

  // First few cards: climb from a product anchor to its smallest card ancestor
  // (same isolation rule as readListingFeed) and dump trimmed outerHTML.
  const seen = new Set();
  for (const a of document.querySelectorAll(`a[href*="${anchorPrefix}"]`)) {
    const href = a.getAttribute("href");
    if (!href || seen.has(href)) continue;
    seen.add(href);
    let card = a;
    while (card.parentElement && card.parentElement.querySelectorAll(`a[href*="${anchorPrefix}"]`).length === 1) {
      card = card.parentElement;
    }
    result.cards.push({ href, html: trunc(card.outerHTML, 1200) });
    if (result.cards.length >= max) break;
  }
  return result;
}

async function run() {
  console.log(`\n# Resale selector capture — query: ${JSON.stringify(query)}\n`);
  if (!process.env.BROWSER_USER_DATA_DIR) {
    console.log("WARNING: BROWSER_USER_DATA_DIR not set — running an ephemeral browser. Sites that gate search behind login may show empty/blocked pages. Point it at the signed-in Chrome profile for best results.\n");
  }
  for (const site of SITES) {
    const target = site.url(query);
    console.log(`\n================ ${site.key} ================`);
    console.log(`URL: ${target}`);
    try {
      const data = await withPage(async (page) => {
        await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
        if (site.anchorPrefix) {
          try { await page.waitForSelector(`a[href*="${site.anchorPrefix}"]`, { timeout: 12000 }); } catch { /* maybe login wall / different prefix */ }
        }
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        return page.evaluate(inspect, { anchorPrefix: site.anchorPrefix, candidates: site.candidates, max: 3 });
      });
      console.log(`landed: ${data.url}`);
      console.log(`page title: ${data.title}`);
      console.log(`top href prefixes: ${data.histogram.map((h) => `${h.prefix}(${h.n})`).join("  ") || "(none)"}`);
      if (!site.anchorPrefix) {
        console.log("(no anchorPrefix configured — use the histogram above to find this site's product-link prefix)");
        continue;
      }
      for (const kind of Object.keys(data.candidateMatches)) {
        console.log(`candidate ${kind}:`);
        for (const c of data.candidateMatches[kind]) {
          console.log(`  ${String(c.n).padStart(3)} x  ${c.sel}${c.sample ? `   e.g. "${c.sample}"` : ""}`);
        }
      }
      console.log(`sample cards (${data.cards.length}):`);
      data.cards.forEach((c, i) => console.log(`  [${i}] ${c.href}\n      ${c.html}`));
    } catch (e) {
      console.log(`ERROR: ${e.message}`);
    }
  }
  await closeBrowser();
  console.log("\n# done — paste this whole output back to lock the selectors\n");
}

run().catch((e) => { console.error(e); process.exit(1); });
