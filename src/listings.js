// Browser seam for the downsizing program: auto-fill a marketplace listing on the
// signed-in profile, STOP before publish, and hand back a resume link so Nic can
// finish + post from his own device (the chosen "auto-fill, you confirm" flow).
// Plus cross-platform pull-down when an item sells ("auto-pull everywhere").
//
// Craigslist / Facebook Marketplace / Nextdoor have NO listing API and actively
// fight automation (CAPTCHAs, DOM churn, account-flagging). So every flow here is:
//   - HEADED on the signed-in Chrome-cos profile (withHeadedPage), the same
//     anti-bot posture reservations use; the 3 sites must be logged in there once
//     (see deploy/setup/downsizing-listings.md).
//   - best-effort + defensive: fill what it can, never throw away the work. It
//     NEVER clicks the final Publish/Post button - the human does. So the worst
//     case is a half-filled draft + a resume link, never a bad public post.
//   - gated: post_listing / pull_listing run behind confirm.js in the orchestrator.
//
// Selectors are intentionally forgiving (role/label/placeholder, several fallbacks)
// because these DOMs change. On first live run, expect to tune a selector or two;
// `unfilled` in the result tells you exactly which field needs attention.

import { withHeadedPage } from "./channels/browser.js";

export const PLATFORM_LABEL = { craigslist: "Craigslist", facebook: "Facebook Marketplace", nextdoor: "Nextdoor" };

// Create-listing entry points. Craigslist is region-scoped; LA for the family.
const CL_SITE = process.env.CRAIGSLIST_SITE || "https://losangeles.craigslist.org";
export function platformCreateUrl(platform) {
  switch (platform) {
    case "facebook": return "https://www.facebook.com/marketplace/create/item";
    case "nextdoor": return "https://nextdoor.com/create_listing/";
    case "craigslist": return `${CL_SITE}/`; // posting starts from the region home ("post")
    default: throw new Error(`unknown platform "${platform}"`);
  }
}

// Where the human resumes to finish a half-filled listing. For Facebook the draft
// persists server-side, so "your listings" is reachable from any device (incl. the
// phone app); for CL/Nextdoor the draft is session-bound to the profile, so the
// resume link is the live page URL we stopped on.
function resumeLink(platform, liveUrl) {
  if (platform === "facebook") return "https://www.facebook.com/marketplace/you/selling";
  return liveUrl;
}

/** Try a sequence of locators; fill the first that exists. Returns true if filled. */
async function tryFill(page, locators, value, { timeout = 2500 } = {}) {
  for (const make of locators) {
    try {
      const loc = make();
      await loc.first().waitFor({ state: "visible", timeout });
      await loc.first().fill(String(value ?? ""));
      return true;
    } catch { /* try next */ }
  }
  return false;
}

/** Upload photos into the first file input on the page (best-effort). */
async function tryUploadPhotos(page, photos = []) {
  if (!photos.length) return false;
  try {
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: "attached", timeout: 3000 });
    await input.setInputFiles(photos);
    return true;
  } catch { return false; }
}

// Per-platform field fillers. Each returns the list of fields it could NOT fill.
const FILLERS = {
  facebook: async (page, item) => {
    const unfilled = [];
    if (!(await tryFill(page, [
      () => page.getByLabel(/^title/i),
      () => page.getByPlaceholder(/title/i),
    ], item.title))) unfilled.push("title");
    if (item.priceAsk != null && !(await tryFill(page, [
      () => page.getByLabel(/^price/i),
      () => page.getByPlaceholder(/price/i),
    ], item.priceAsk))) unfilled.push("price");
    if (item.description && !(await tryFill(page, [
      () => page.getByLabel(/description/i),
      () => page.getByPlaceholder(/description/i),
      () => page.locator("textarea"),
    ], item.description))) unfilled.push("description");
    // Category/condition are dropdowns that vary; leave for the human.
    if (item.category) unfilled.push("category (pick in the form)");
    if (item.condition) unfilled.push("condition (pick in the form)");
    return unfilled;
  },
  nextdoor: async (page, item) => {
    const unfilled = [];
    if (!(await tryFill(page, [
      () => page.getByLabel(/title|what.*selling/i),
      () => page.getByPlaceholder(/title|item/i),
    ], item.title))) unfilled.push("title");
    if (item.priceAsk != null && !(await tryFill(page, [
      () => page.getByLabel(/price/i),
      () => page.getByPlaceholder(/price/i),
    ], item.priceAsk))) unfilled.push("price");
    if (item.description && !(await tryFill(page, [
      () => page.getByLabel(/description/i),
      () => page.getByPlaceholder(/description|detail/i),
      () => page.locator("textarea"),
    ], item.description))) unfilled.push("description");
    return unfilled;
  },
  craigslist: async (page, item) => {
    // CL first requires choosing "for sale by owner" + a category + area on interstitial
    // pages before the posting form. Those choices are click-throughs we leave to the
    // human (they gate the form). Once on the form, fill title/price/body/postal.
    const unfilled = ["category + area (pick on the CL steps first)"];
    if (!(await tryFill(page, [
      () => page.getByLabel(/posting title/i),
      () => page.locator("#PostingTitle"),
      () => page.getByPlaceholder(/posting title/i),
    ], item.title))) unfilled.push("title");
    if (item.priceAsk != null && !(await tryFill(page, [
      () => page.getByLabel(/^price/i),
      () => page.locator("#price"),
    ], item.priceAsk))) unfilled.push("price");
    if (item.description && !(await tryFill(page, [
      () => page.getByLabel(/posting body/i),
      () => page.locator("#PostingBody"),
      () => page.locator("textarea").first(),
    ], item.description))) unfilled.push("description");
    return unfilled;
  },
};

/**
 * Auto-fill a listing on `platform` for `item`, stopping BEFORE publish.
 * @returns {{platform, reviewUrl, resumeUrl, filled:boolean, unfilled:string[], transcript:string[]}}
 */
export async function postListing({ platform, item, timeoutMs = 60000 } = {}) {
  if (!FILLERS[platform]) throw new Error(`unknown platform "${platform}"`);
  if (!item?.title) throw new Error("item with a title is required");
  const createUrl = platformCreateUrl(platform);
  return withHeadedPage(async (page) => {
    const transcript = [];
    await page.goto(createUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    transcript.push(`goto ${createUrl}`);
    // If we got bounced to a login wall, bail with a clear signal (profile not signed in).
    if (/login|checkpoint|signin/i.test(page.url())) {
      return { platform, reviewUrl: page.url(), resumeUrl: resumeLink(platform, page.url()),
        filled: false, unfilled: ["ALL - profile not signed in to " + PLATFORM_LABEL[platform]], transcript };
    }
    const uploaded = await tryUploadPhotos(page, item.photos);
    transcript.push(uploaded ? `uploaded ${item.photos.length} photo(s)` : "photos not uploaded (add in form)");
    const unfilled = await FILLERS[platform](page, item);
    transcript.push(`filled title/price/description best-effort; unfilled: ${unfilled.join(", ") || "none"}`);
    const liveUrl = page.url();
    // Deliberately DO NOT click Publish. Leave the draft on-screen.
    return {
      platform,
      reviewUrl: liveUrl,
      resumeUrl: resumeLink(platform, liveUrl),
      filled: !unfilled.some((u) => u.startsWith("ALL")),
      unfilled,
      transcript,
    };
  });
}

/**
 * Pull an item's listing down on `platform` (sold elsewhere). Best-effort: opens
 * the listing's manage menu and attempts Mark as Sold / Delete. Because the DOM is
 * volatile and this is destructive, it STOPS before the final irreversible confirm
 * and returns the manage URL for the human to finish. Gated upstream by confirm.js.
 * @returns {{platform, done:boolean, manageUrl:string, transcript:string[]}}
 */
export async function pullListing({ platform, item, timeoutMs = 45000 } = {}) {
  const url = item?.platforms?.[platform]?.url;
  const manageUrl = url || (platform === "facebook" ? "https://www.facebook.com/marketplace/you/selling" : platformCreateUrl(platform));
  return withHeadedPage(async (page) => {
    const transcript = [];
    await page.goto(manageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    transcript.push(`goto ${manageUrl}`);
    let opened = false;
    for (const make of [
      () => page.getByRole("button", { name: /mark as sold|manage|edit|more|options/i }),
      () => page.getByText(/mark as sold/i),
    ]) {
      try { await make().first().click({ timeout: 2500 }); opened = true; transcript.push("opened manage menu"); break; } catch { /* next */ }
    }
    // Stop before the irreversible confirm; return the page so the human finishes.
    return { platform, done: false, manageUrl: page.url(), openedMenu: opened, transcript };
  });
}
