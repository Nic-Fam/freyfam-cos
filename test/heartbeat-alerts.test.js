import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-heartbeat-alerts-test.json");
process.env.HEARTBEAT_ALERTS_PATH = TMP;
const { shouldAlert, recordAlerted, dismissAlert, alertSignature, significantWords } = await import("../src/heartbeat-alerts.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("alertSignature is stable across stopword/punctuation/order noise", () => {
  const a = alertSignature("Amazon Data Request Confirmation (DSAR) today");
  const b = alertSignature("today, a DSAR — Amazon data-request confirmation");
  assert.equal(a, b); // same content words, differing only in stopwords/order/punctuation
});

test("a fresh alert sends; a repeat within the TTL is suppressed", async () => {
  const text = "Unrecognized Amazon DSAR data request confirmation email";
  assert.equal(await shouldAlert(text), true);
  await recordAlerted(text);
  assert.equal(await shouldAlert(text), false); // deduped within TTL
});

test("the same alert sends again after the TTL elapses", async () => {
  const text = "Amazon DSAR data request confirmation";
  await recordAlerted(text, { now: 1000 });
  assert.equal(await shouldAlert(text, { now: 1000 + 60_000 }), false);
  assert.equal(await shouldAlert(text, { now: 1000 + 25 * 60 * 60 * 1000 }), true); // >24h
});

test("dismiss permanently suppresses the topic, fuzzy across rephrasing", async () => {
  await dismissAlert("Amazon DSAR data request confirmation");
  // The heartbeat will phrase it differently on a later tick — still suppressed.
  assert.equal(await shouldAlert("Heads up: Amazon sent a data request (DSAR) confirmation nobody recognizes"), false);
  // An unrelated alert is NOT suppressed.
  assert.equal(await shouldAlert("Costco charged a duplicate membership fee"), true);
});

test("dismiss refuses a too-vague topic", async () => {
  const r = await dismissAlert("it");
  assert.equal(r.ok, false);
});
