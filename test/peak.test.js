import { test } from "node:test";
import assert from "node:assert";
import { parsePeakHours, inPeak, minuteInPeak } from "../src/peak.js";
import { dueSlots } from "../src/resale-schedule.js";
import { closeBrowserIfIdle, browserInUse } from "../src/channels/browser.js";

const TZ = "America/Los_Angeles";
const PEAK = { start: 16, end: 21 };
// Nov 11 2026 is PST (UTC-8).
const at = (hhmm) => new Date(`2026-11-11T${hhmm}:00-08:00`);

test("parsePeakHours reads '16-21', tolerates ':00', and 'off' disables", () => {
  assert.deepEqual(parsePeakHours("16-21"), { start: 16, end: 21 });
  assert.deepEqual(parsePeakHours(" 16:00 - 21:00 "), { start: 16, end: 21 });
  for (const x of ["off", "", "none", "nonsense", "5-5", "25-3"]) assert.equal(parsePeakHours(x), null, x);
});

test("inPeak is 4:00pm up to (not including) 9:00pm Los Angeles time", () => {
  assert.equal(inPeak(at("15:59"), { hours: PEAK, tz: TZ }), false);
  assert.equal(inPeak(at("16:00"), { hours: PEAK, tz: TZ }), true);
  assert.equal(inPeak(at("20:59"), { hours: PEAK, tz: TZ }), true);
  assert.equal(inPeak(at("21:00"), { hours: PEAK, tz: TZ }), false);
  assert.equal(inPeak(at("18:00"), { hours: null, tz: TZ }), false, "disabled");
  assert.equal(minuteInPeak(23 * 60, { start: 22, end: 6 }), true, "wrapping window");
});

test("resale slots inside peak are deferred to 9pm and come due together", () => {
  const opts = { slots: ["14:30", "16:05", "18:30", "20:30"].map((label) => ({ label, minutes: Number(label.slice(0, 2)) * 60 + Number(label.slice(3)) })), tz: TZ, peak: PEAK };
  assert.deepEqual(dueSlots(at("16:10"), {}, opts).due, [], "nothing runs at 4:10pm");
  assert.deepEqual(dueSlots(at("18:35"), {}, opts).due, [], "nothing runs at 6:35pm");
  assert.deepEqual(dueSlots(at("21:05"), {}, opts).due.map((d) => d.label), ["16:05", "18:30", "20:30"], "all three at 9pm, as one batch");
  assert.deepEqual(dueSlots(at("14:35"), {}, opts).due.map((d) => d.label), ["14:30"], "off-peak slots unchanged");
  const ran = { "16:05": "2026-11-11", "18:30": "2026-11-11", "20:30": "2026-11-11" };
  assert.deepEqual(dueSlots(at("21:20"), ran, opts).due, [], "once per day");
});

test("without a peak window, dueSlots keeps its original schedule", () => {
  const opts = { slots: [{ label: "16:05", minutes: 16 * 60 + 5 }], tz: TZ };
  assert.deepEqual(dueSlots(at("16:10"), {}, opts).due.map((d) => d.label), ["16:05"]);
});

test("closeBrowserIfIdle is a safe no-op when no browser is running", async () => {
  assert.equal(browserInUse(), 0);
  assert.equal(await closeBrowserIfIdle(), true);
});
