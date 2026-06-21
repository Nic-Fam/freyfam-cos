import { test } from "node:test";
import assert from "node:assert";
import { weekDates, fetchFoxWeek } from "../src/fox-curriculum.js";

test("weekDates maps Mon..Fri from a 'Week of M/D/YYYY' anchor", () => {
  const d = weekDates("6/15/2026", 5);
  assert.deepEqual(d, ["2026-06-15", "2026-06-16", "2026-06-17", "2026-06-18", "2026-06-19"]);
});

test("weekDates rolls over month/year boundaries", () => {
  assert.deepEqual(weekDates("12/29/2025", 5), [
    "2025-12-29", "2025-12-30", "2025-12-31", "2026-01-01", "2026-01-02",
  ]);
});

test("weekDates returns [] when no date is present", () => {
  assert.deepEqual(weekDates("no date here"), []);
});

test("fetchFoxWeek rejects non-http(s) URLs", async () => {
  await assert.rejects(() => fetchFoxWeek("file:///etc/passwd"), /http/);
});
