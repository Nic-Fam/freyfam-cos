// Live verify for the browser-dependent workstreams (G browser automation, and the
// F resale marketplace fetchers / TheRealReal First Look grid that ride the same
// capability). Unlike test/browser.test.js — which only exercises the pre-launch
// guard + validation so it passes WITHOUT a browser — this script launches the real
// headless Chromium and drives the actual primitives end to end. Run it on Lloyd's
// mini (where Playwright + a Chromium binary are installed) to flip the "live verify"
// boxes in TRACKER.md G/F:
//
//   npm i playwright && npx playwright install chromium   # one time
//   node scripts/verify-browser.mjs
//
// It proves: readPage (title + visible text + structured price signals across
// JSON-LD / og:meta / microdata), runOrder (goto/fill/click/waitFor checkout
// primitives), and readListingFeed (one isolated row per product anchor). All drive
// self-contained data: URLs so the check needs no live site or logins; pass a URL
// argument to additionally smoke a real page read. If Playwright/Chromium are not
// installed the script SKIPS cleanly (exit 0) — the daemon treats the browser as an
// optional capability, so absence is not a failure here either.
import { readPage, runOrder, readListingFeed, closeBrowser } from "../src/channels/browser.js";

process.env.BROWSER_HEADLESS = process.env.BROWSER_HEADLESS ?? "true";

let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
  if (!cond) failures++;
};
const b64 = (html) => "data:text/html;base64," + Buffer.from(html).toString("base64");

try {
  // 1. READ-ONLY browse: title, visible text, and price from structured signals.
  const productUrl = b64(`<!doctype html><html><head><title>Vintage Chanel Flap Bag</title>
    <meta property="product:price:amount" content="3250.00">
    <script type="application/ld+json">
    {"@type":"Product","name":"Chanel Flap","offers":{"@type":"Offer","price":"3200.00","priceCurrency":"USD"}}
    </script></head>
    <body><h1>Vintage Chanel Flap Bag</h1>
    <span itemprop="price" content="3199.99">$3,199.99</span>
    <p>Excellent condition. Ships in 2 days.</p></body></html>`);
  const r = await readPage(productUrl, { maxChars: 4000 });
  check("readPage returns title", r.title === "Vintage Chanel Flap Bag", JSON.stringify(r.title));
  check("readPage returns visible text", /Excellent condition/.test(r.text));
  check("readPage extracts JSON-LD price", r.priceSignals.jsonLd === 3200, `jsonLd=${r.priceSignals.jsonLd}`);
  check("readPage extracts og/meta price", r.priceSignals.meta === 3250, `meta=${r.priceSignals.meta}`);
  check("readPage extracts microdata price", r.priceSignals.microdata === 3199.99, `micro=${r.priceSignals.microdata}`);

  // 2. ORDER primitives: goto -> fill -> click -> waitFor a confirmation element.
  const checkoutUrl = b64(`<!doctype html><html><head><title>Checkout</title></head><body>
    <input id="qty" />
    <button id="buy" onclick="document.getElementById('done').style.display='block'">Place order</button>
    <div id="done" style="display:none">Order confirmed</div></body></html>`);
  const o = await runOrder({
    url: checkoutUrl,
    pace: false,
    steps: [
      { action: "fill", selector: "#qty", value: "1" },
      { action: "click", selector: "#buy" },
      { action: "waitFor", selector: "#done:visible" },
    ],
  });
  check("runOrder ok + ran every step", o.ok === true && o.transcript.length === 4, o.transcript.join(" | "));

  // 3. LISTING FEED: one row per product anchor, fields isolated to each card.
  const gridUrl = b64(`<!doctype html><html><head><title>New Arrivals</title></head><body><div class="grid">
    <div class="card"><a href="/products/aaa"><span class="brand">Gucci</span><span class="price">$1,200</span></a></div>
    <div class="card"><a href="/products/bbb"><span class="brand">Prada</span><span class="price">$840</span></a></div>
    <div class="card"><a href="/products/ccc"><span class="brand">Hermes</span><span class="price">$5,400</span></a></div>
    </div></body></html>`);
  const { items } = await readListingFeed(gridUrl, { anchorPrefix: "/products/", fields: { brand: ".brand", price: ".price" } });
  check("readListingFeed isolates one row per card", items.length === 3 && items[0].brand === "Gucci" && items[2].href === "/products/ccc", JSON.stringify(items));

  // 4. Optional live read of a real page (pass a URL arg).
  const liveUrl = process.argv[2];
  if (liveUrl) {
    const live = await readPage(liveUrl, { timeoutMs: 20000 });
    check(`LIVE read ${liveUrl}`, Boolean(live.title), live.title);
  }
} catch (e) {
  if (/needs Playwright|Executable doesn't exist|playwright install/i.test(e.message)) {
    console.log(`SKIP  Playwright/Chromium not installed on this host — browser is an optional capability.`);
    console.log(`      ${e.message.split("\n")[0]}`);
    await closeBrowser().catch(() => {});
    process.exit(0);
  }
  throw e;
} finally {
  await closeBrowser().catch(() => {});
}

console.log(`\n${failures === 0 ? "ALL GREEN" : failures + " FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
