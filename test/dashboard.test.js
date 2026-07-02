import { test } from "node:test";
import assert from "node:assert";
import { formatDashboard } from "../src/dashboard.js";

test("formatDashboard marks earlier-today events as already passed", () => {
  const out = formatDashboard({
    dateLabel: "Wednesday, July 1",
    nowLabel: "6:52 PM",
    nowHM: "18:52",
    events: [
      { time: "16:00", title: "Summer Family Picnic" },
      { time: "20:00", title: "Bedtime story" },
    ],
  });
  assert.match(out, /it is now 6:52 PM/);
  assert.match(out, /16:00 Summer Family Picnic — already passed/);
  assert.doesNotMatch(out, /Bedtime story — already passed/); // 8pm is still upcoming
});

test("formatDashboard without now info does not annotate (back-compat)", () => {
  const out = formatDashboard({ dateLabel: "X", events: [{ time: "16:00", title: "Picnic" }] });
  assert.doesNotMatch(out, /already passed/);
  assert.doesNotMatch(out, /it is now/);
});

test("Fox section carries a compare-to-now hint", () => {
  const out = formatDashboard({ dateLabel: "X", nowLabel: "6:52 PM", nowHM: "18:52", fox: { activities: "Picnic at 4pm", wardrobe: "casual" } });
  assert.match(out, /compare each listed time to the current time/i);
});
