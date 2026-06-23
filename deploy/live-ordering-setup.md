# Live browser setup session — Ralphs ordering, TheRealReal First Look, price-watch

Everything below is built and tested EXCEPT the live, site-specific browser steps
(selectors) and the logged-in flows. Those must be captured in one hands-on
session, on the device that will run it, with Nic/Shelli present (real logins,
real money). This runbook makes that session fast.

## Where it runs
Lloyd's local Mac (the always-on Mac mini) — residential IP, never Azure. Lloyd
drives the browser on behalf of the Azure specialists (Carmine picks the grocery
list; Shelli's First Look is Shelli's account). Steve/Frank are local for their own.

### Doing it BEFORE the mini is set up (and moving it over)
Fine to run this on any home Mac now — it's still a residential IP. What you
capture is portable:
- `data/ralphs-steps.json` (the checkout selectors) is SITE-specific, not
  machine-specific — it commits to the repo and deploys to the mini as-is.
- The extractPrice tuning + First Look wiring are code — they move with git.
On the mini you only re-do the machine-local bits: sign Chrome in to the accounts
(or enable Chrome Sync so passwords carry over), point `BROWSER_USER_DATA_DIR` at
the mini's profile path, `npx playwright install chrome`, and do ONE gated
verification run (different machine / possibly newer Chrome) before trusting an
unattended order.

## Prep checklist (do BEFORE the session)
1. **On Lloyd's Mac, in Chrome, be signed in to:**
   - ralphs.com — account with the delivery address + a saved payment method (no 2FA, confirmed). Clip nothing; we'll automate the 4x fuel-points coupon.
   - therealreal.com — Shelli's account with the **First Look (men's)** membership active.
2. **Find that Chrome profile's path** (Chrome → `chrome://version` → "Profile Path"). Set in `.env`:
   - `BROWSER_CHANNEL=chrome`
   - `BROWSER_USER_DATA_DIR=<that profile path's PARENT "User Data" dir>`
   - `BROWSER_HEADLESS=false` for the session (so we can watch + handle any prompt)
   - Quit Chrome before runs (Playwright needs exclusive access to the profile).
3. **Install the driver:** `npm i playwright && npx playwright install chrome`
4. Keep `ANTHROPIC_API_KEY` funded; have the daemon stopped during capture so it
   isn't competing for the profile.

## Session plan (what we'll do together)
**A. Ralphs order (the Friday flow's checkout)** — capture into `data/ralphs-steps.json`:
   1. Confirm the profile is signed in (no login step needed if so).
   2. Clip the 4x fuel-points digital coupon.
   3. Add each cart item; if an item isn't available, SKIP it (the out-of-stock =
      drop policy is already in code — we wire the "not addable" detection here).
   4. Choose a Friday-evening delivery slot.
   5. Review cart; STOP before pay for the first 2-3 dry runs.
   6. Once selectors are solid, do one real gated order end-to-end (approve via the
      email/Slack button), extremely slow.
   - Result: `placeRalphsOrder` runs the captured plan; the Friday trigger already
     assembles + asks for approval.

**B. TheRealReal First Look** — DONE (built 2026-06-23). Captured the new-arrivals
   grid selectors live (`product-card/brand`, `product-card/description`,
   `product-price/final`; cards isolated by climbing from the `/products/` anchor)
   and built `src/resale-feed.js` (`runFirstLookFeed`) + the generic
   `readListingFeed` in `browser.js`. Wired into the 7:05a/4:05p resale runs in
   `heartbeat.js`: it reads the feed locally and surfaces only NEW items (seeds
   silently on first run so it doesn't dump the whole grid). GO-LIVE: sign Shelli's
   Chrome profile into therealreal.com (First Look men's membership) so the feed
   shows early-access items; until then it no-ops gracefully (a sign-in redirect
   yields an empty feed). Optionally pin `TRR_FEED_URL` to her men's taxon.

**C. Price-watch — DONE (built 2026-06-23), now MULTI-SITE.** Replaced the fragile
   "first dollar sign in the text" heuristic. `readPage` now harvests structured
   price signals in-page (schema.org JSON-LD `offers.price`, then product/OG meta,
   then microdata `itemprop=price`), and `watch.js` `pickPrice` prefers those over
   visible text. Verified live that the same path reads TheRealReal ($245) and eBay
   ($459.99) with no per-site selectors, so any watched listing across the resale
   sites reads correctly. No per-site tuning needed for sites that emit standard
   product structured data (TheRealReal, eBay, Poshmark, Vestiaire, 1stDibs, Shopify).

## Risk to expect
Kroger and CVS run bot-protection. A signed-in real-Chrome profile + slow,
human-like pacing (already built: `ORDER_STEP_MIN/MAX_MS`, `BROWSER_SLOWMO_MS`) is
the mitigation. If a flow still gets challenged, fall back to "assemble the cart,
you tap Place Order" (semi-automated) — the assembly/coupon/slot steps still save
the time.

## Status of the code pieces (all committed, tested)
- Grocery: schedule + assemble + OOS-drop + gated Friday proposal + executor seam.
- Resale feed: scheduled saved-search runs (7:05a/4:05p + daytime cadence), hit tracker.
- Price-watch: watch/list/unwatch + drop/target flagging on the resale schedule.
- Browser: persistent real-Chrome profile + slow pacing, local-only.
