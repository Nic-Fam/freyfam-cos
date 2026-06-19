import test from "node:test";
import assert from "node:assert";
import { readPage, runOrder, closeBrowser } from "../src/channels/browser.js";
import { OutboundBlockedError } from "../src/guards.js";

// These tests deliberately exercise only the pre-launch paths (guard checks and
// input validation), so they pass whether or not Playwright is installed: none of
// them reach the actual headless-browser launch.

test("runOrder refuses read-only work domains before launching", async () => {
  for (const url of ["https://disney.com/store/checkout", "https://flyerdefense.com/buy"]) {
    await assert.rejects(() => runOrder({ url }), OutboundBlockedError, url);
  }
});

test("runOrder requires a url", async () => {
  await assert.rejects(() => runOrder({}), /url is required/);
});

test("readPage rejects an invalid url before launching", async () => {
  await assert.rejects(() => readPage("not a url"), /Invalid URL/);
});

test("closeBrowser is a safe no-op when nothing was launched", async () => {
  await assert.doesNotReject(() => closeBrowser());
});
