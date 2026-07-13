# Downsizing listings — one-time setup

The downsizing program (move sale) auto-fills Craigslist / Facebook Marketplace /
Nextdoor listings on Lloyd's signed-in browser, stops before publish, and hands Nic
a link to finish and post. For the auto-fill to work, those three sites must be
signed in **on the Chrome-cos automation profile**, under the exact launch flags the
daemon uses (same requirement as Resy/OpenTable/TheRealReal).

## Sign the three sites in (once)

On Lloyd's Mac mini, launch Chrome with the automation profile and log in by hand:

```bash
# Uses the same profile + flags src/channels/browser.js launches with.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$BROWSER_USER_DATA_DIR" \
  --password-store=basic --use-mock-keychain \
  --no-first-run --no-default-browser-check \
  --disable-blink-features=AutomationControlled
```

Then in that window, log into and stay signed in on:
- **facebook.com** (Marketplace) — https://www.facebook.com/marketplace/create/item
- **nextdoor.com** — verified to the La Canada/La Crescenta neighborhood
- **losangeles.craigslist.org** — a CL account with the family email verified

Close the window when done. Cookies persist in the profile; the daemon reuses them.

## How posting works

- `post_listing` navigates to each platform's create-listing page, uploads the item
  photos, fills title / price / description best-effort, and **stops before Publish**.
- It returns a **resume link**:
  - **Facebook** saves the draft server-side, so the link is *Your listings → selling*
    and Nic can finish from the **phone app** or any device.
  - **Craigslist / Nextdoor** drafts are session-bound to the profile, so the link is
    the live page on the mini; Nic finishes there (or Lloyd re-fills on request).
- Category / condition dropdowns and Craigslist's category+area steps are left for the
  human (they gate the form and vary too much to automate safely). `post_listing`
  reports exactly which fields it couldn't fill.

## Selling + auto-pull

- `mark_item_sold` records the sale and, for every OTHER platform the item is still
  live on, stages a take-down through the confirmation gate. On Nic's YES the
  `listing_pull` handler opens each listing's manage page and reports a link to finish
  the removal, marking it pulled locally.

## First live run

These three DOMs change often and fight automation. On the first real post expect to
tune a selector or two in `src/listings.js` (the `FILLERS` map) — the `unfilled` list
in the result names the field that needs attention. The flow is designed so the worst
case is a half-filled draft plus a resume link, never a bad public post.
