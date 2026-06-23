# Live browser setup session — Ralphs ordering, TheRealReal First Look, price-watch

Everything below is built and tested EXCEPT the live, site-specific browser steps
(selectors) and the logged-in flows. Those must be captured in one hands-on
session, on the device that will run it, with Nic/Shelli present (real logins,
real money). This runbook makes that session fast.

## Where it runs
Lloyd's local Mac (the always-on Mac mini) — residential IP, never Azure. Lloyd
drives the browser on behalf of the Azure specialists (Carmine picks the grocery
list; Shelli's First Look is Shelli's account). Steve/Frank are local for their own.

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

**B. TheRealReal First Look** — capture how to read her First Look new-arrivals
   feed while signed in; wire a `browse_page` of it into the 7:05a/4:05p resale
   runs so early-access items surface (generic web search can't see them).

**C. Price-watch tuning** — open a couple of real listing pages and tune
   `extractPrice` (src/watch.js) per site so the watched-item price is read
   correctly.

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
