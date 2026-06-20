import test from "node:test";
import assert from "node:assert";
import { readPage, runOrder, closeBrowser } from "../src/channels/browser.js";

// These tests deliberately exercise only the pre-launch paths (input validation),
// so they pass whether or not Playwright is installed: none reach the actual
// headless-browser launch. (The old work-domain hard block was removed 2026-06-20;
// purchases are protected by the confirmation gate in the tool layer, not here.)

test("runOrder requires a url", async () => {
  await assert.rejects(() => runOrder({}), /url is required/);
});

test("readPage rejects an invalid url before launching", async () => {
  await assert.rejects(() => readPage("not a url"), /Invalid URL/);
});

test("closeBrowser is a safe no-op when nothing was launched", async () => {
  await assert.doesNotReject(() => closeBrowser());
});
