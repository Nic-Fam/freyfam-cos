import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const PKGS = join(os.tmpdir(), "cos-pkg-digest-test.json");
process.env.PACKAGES_PATH = PKGS;
const { shouldRunPackageDigest, composePackageDigest, runPackageDigest } = await import("../src/package-digest.js");
const { addPackage, markDelivered } = await import("../src/packages.js");

const TZ = "America/Los_Angeles";
const cfg = { hour: 17, minute: 30, windowMinutes: 60, weekdaysOnly: true, tz: TZ };
const MON = Date.parse("2026-06-15T17:35:00-07:00"); // Monday 5:35pm LA

beforeEach(() => rm(PKGS, { force: true }));
after(() => rm(PKGS, { force: true }));

test("shouldRunPackageDigest: weekday inside the 5:30 window only, once/day", () => {
  assert.equal(shouldRunPackageDigest(new Date(MON), null, cfg).run, true);
  assert.equal(shouldRunPackageDigest(new Date(MON), "2026-06-15", cfg).run, false); // already ran today
  assert.equal(shouldRunPackageDigest(new Date("2026-06-13T17:35:00-07:00"), null, cfg).run, false); // Saturday
  assert.equal(shouldRunPackageDigest(new Date("2026-06-15T09:00:00-07:00"), null, cfg).run, false); // before window
  assert.equal(shouldRunPackageDigest(new Date("2026-06-15T19:00:00-07:00"), null, cfg).run, false); // after window
});

test("composePackageDigest lists only today's pickup-location deliveries", async () => {
  // delivered today, at the UPS Store pickup -> included
  await addPackage({ trackingNumber: "T1", carrier: "UPS", description: "Diapers", owner: "nic", pickup: true, location: "The UPS Store" });
  await markDelivered("T1", MON, { pickup: true, location: "The UPS Store" });
  // delivered today, but to the home (not a pickup) -> excluded
  await addPackage({ trackingNumber: "T2", carrier: "Amazon", description: "Home box", pickup: false });
  await markDelivered("T2", MON);
  // pickup delivery, but yesterday -> excluded
  await addPackage({ trackingNumber: "T3", carrier: "UPS", description: "Old box", pickup: true, location: "The UPS Store" });
  await markDelivered("T3", MON - 24 * 60 * 60 * 1000, { pickup: true });

  const d = await composePackageDigest({ now: new Date(MON), tz: TZ });
  assert.equal(d.count, 1);
  assert.match(d.text, /UPS Store \(Foothill\)/);
  assert.match(d.text, /Nic: Diapers \(UPS T1\)/); // tracking number included
  assert.doesNotMatch(d.text, /Home box|Old box/);
});

test("runPackageDigest sends only when something was delivered (iMessage channel injected)", async () => {
  const sent = [];
  const notify = async (text) => { sent.push(text); return "guid"; };

  // nothing logged -> no send
  let r = await runPackageDigest({ notify, now: new Date(MON), cfg });
  assert.equal(r.sent, false);
  assert.equal(sent.length, 0);

  await addPackage({ trackingNumber: "T9", carrier: "UPS", description: "Shoes", owner: "shelli", pickup: true, location: "The UPS Store" });
  await markDelivered("T9", MON, { pickup: true });
  r = await runPackageDigest({ notify, now: new Date(MON), cfg });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Shelli: Shoes/);
});
