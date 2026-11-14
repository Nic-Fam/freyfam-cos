import "dotenv/config";
import { withPage, withHeadedPage, closeBrowser } from "../src/channels/browser.js";
import { parseFeedText, pickStudent, isSignInWall } from "../src/brightwheel.js";
import { BRIGHTWHEEL } from "../src/config.js";

// ===========================================================================
// One-off diagnostic — run on Lloyd's mini to LOCK the Brightwheel feed parsing
// in src/brightwheel.js against the REAL signed-in page. Dumps:
//   - the URL we landed on (and whether it's a sign-in wall)
//   - every /students/<id> anchor found, and which one pickStudent chooses
//   - the raw feed innerText (first ~6k chars)
//   - what parseFeedText makes of it: date / time / kind / text per entry
// Paste the output back to Claude and we tighten the kind patterns + date
// headers against real markup instead of guesses.
//
// READ-ONLY: no messages sent, no check-in/out, nothing written to Brightwheel.
//
// Usage (on the mini, with the .env that has BROWSER_CHANNEL/BROWSER_USER_DATA_DIR):
//   node tools/capture-brightwheel.mjs
//   # force a visible window if the headless crawl hits a wall:
//   BRIGHTWHEEL_HEADED=true node tools/capture-brightwheel.mjs
// (Quit Chrome first so Playwright can drive the profile.)
// ===========================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runner = BRIGHTWHEEL.headed ? withHeadedPage : withPage;

try {
  await runner(async (page) => {
    await page.goto(BRIGHTWHEEL.homeUrl, { waitUntil: "domcontentloaded", timeout: BRIGHTWHEEL.timeoutMs });
    await sleep(BRIGHTWHEEL.settleMs);
    console.log(`landed: ${page.url()}`);
    if (isSignInWall(page.url())) {
      console.log(
        "\nSIGN-IN WALL. This profile isn't signed into Brightwheel.\n" +
          "Sign in by hand ONCE in this Chrome profile (launch it with the same\n" +
          "--password-store=basic --use-mock-keychain flags browser.js uses), then re-run.\n"
      );
      return;
    }

    const anchors = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll("a[href]"))
          .slice(0, 400)
          .map((a) => ({ href: a.href, text: (a.innerText || a.textContent || "").trim().slice(0, 60) }))
      )
      .catch(() => []);
    const studentLinks = anchors.filter((a) => /\/students\//i.test(a.href));
    console.log(`\n--- /students/ anchors (${studentLinks.length}) ---`);
    for (const a of studentLinks.slice(0, 20)) console.log(`  ${a.text || "(no text)"} -> ${a.href}`);
    const student = pickStudent(anchors);
    console.log(`pickStudent -> ${student ? `${student.name || "(unnamed)"} ${student.id}` : "null (will parse the landing page)"}`);

    if (student) {
      await page.goto(student.href, { waitUntil: "domcontentloaded", timeout: BRIGHTWHEEL.timeoutMs });
      await sleep(BRIGHTWHEEL.settleMs);
      console.log(`feed url: ${page.url()}`);
    }

    const text = await page.innerText("body").catch(() => "");
    console.log(`\n--- raw innerText (${text.length} chars, first 6000) ---\n${text.slice(0, 6000)}`);

    const entries = parseFeedText(text);
    console.log(`\n--- parseFeedText -> ${entries.length} entries ---`);
    for (const e of entries.slice(0, 60)) console.log(`  ${e.date} ${e.time.padEnd(8)} ${e.kind.padEnd(12)} ${e.text.slice(0, 90)}`);
  });
} finally {
  await closeBrowser();
}
