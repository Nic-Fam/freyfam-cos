import { test, beforeEach, after } from "node:test";
import assert from "node:assert";
import { rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

const TMP = join(os.tmpdir(), "cos-packages-test.json");
process.env.PACKAGES_PATH = TMP;
const pkg = await import("../src/packages.js");

beforeEach(() => rm(TMP, { force: true }));
after(() => rm(TMP, { force: true }));

test("extractTrackingNumbers finds each carrier and dedupes", () => {
  const text = "UPS 1Z999AA10123456784 and Amazon TBA303384950001 and USPS 9400111899223817591234.";
  const found = pkg.extractTrackingNumbers(text);
  const carriers = found.map((f) => f.carrier).sort();
  assert.ok(carriers.includes("UPS") && carriers.includes("Amazon") && carriers.includes("USPS"));
  assert.match(found.find((f) => f.carrier === "UPS").url, /ups\.com/);
});

test("isShippingEmail vs isDeliveryConfirmation: future delivery is NOT a confirmation", () => {
  assert.equal(pkg.isShippingEmail("Your order has shipped", "tracking 1Z..."), true);
  // The classic false positive the legacy code fixed: must NOT count as delivered.
  assert.equal(pkg.isDeliveryConfirmation("Arriving soon", "Your package will be delivered Tuesday"), false);
  assert.equal(pkg.isDeliveryConfirmation("Out for delivery", "out for delivery today"), false);
  // A real completed delivery DOES count.
  assert.equal(pkg.isDeliveryConfirmation("Delivered: your package", ""), true);
  assert.equal(pkg.isDeliveryConfirmation("Update", "Your package was delivered at 2:14pm"), true);
});

test("processShipmentEmail tracks a shipping notice, then a later email marks it delivered", async () => {
  const tn = "1Z999AA10123456784";
  const ship = await pkg.processShipmentEmail({ subject: "Shipped", body: `On its way: ${tn}`, description: "Diapers" });
  assert.equal(ship.tracked.length, 1);
  assert.deepEqual((await pkg.listActivePackages()).map((p) => p.trackingNumber), [tn]);

  const deliver = await pkg.processShipmentEmail({ subject: `Delivered: your order ${tn}`, body: "" });
  assert.equal(deliver.delivered.length, 1);
  assert.deepEqual(await pkg.listActivePackages(), [], "delivered package leaves the active list");
});

test("formatPackages reads cleanly and handles empty", () => {
  assert.match(pkg.formatPackages([]), /No packages/i);
  const out = pkg.formatPackages([{ trackingNumber: "TBA303384950001", carrier: "Amazon", description: "Books", addedAt: "2026-06-22T00:00:00Z" }]);
  assert.match(out, /Books — Amazon TBA303384950001/);
});

test("attributeOwner defaults to Nic unless the email names Shelli", () => {
  assert.equal(pkg.attributeOwner("Your order shipped", "Ship to: Nic Frey"), "nic");
  assert.equal(pkg.attributeOwner("Shipped", "no name here"), "nic"); // default
  assert.equal(pkg.attributeOwner("Shelli, your order shipped", "Ship to Shelli Frey"), "shelli");
});

test("detectPickupLocation flags pickup locations and labels them, ignores home delivery", () => {
  assert.deepEqual(pkg.detectPickupLocation("Ready", "Your package is at The UPS Store, 123 Main St."), {
    isPickup: true,
    location: "The UPS Store",
  });
  assert.equal(pkg.detectPickupLocation("Picked", "Available for pickup at the Amazon Hub Locker").isPickup, true);
  assert.deepEqual(pkg.detectPickupLocation("Out for delivery", "Arriving at your home today"), { isPickup: false, location: "" });
});

test("processShipmentEmail records owner + pickup + location; pickup queue and mark work", async () => {
  const tn = "1Z999AA10123456784";
  const r = await pkg.processShipmentEmail({
    subject: "Shelli, your package is ready",
    body: `Available for pickup at The UPS Store. Tracking ${tn}.`,
    description: "Dress",
  });
  assert.equal(r.owner, "shelli");
  assert.equal(r.pickup, true);
  assert.equal(r.location, "The UPS Store");

  const [stored] = await pkg.listActivePackages();
  assert.equal(stored.owner, "shelli");
  assert.equal(stored.pickup, true);
  assert.equal(stored.location, "The UPS Store");

  // It shows up as needing a pickup event, until we mark it proposed.
  let queue = await pkg.listPickupsNeedingSchedule();
  assert.deepEqual(queue.map((p) => p.trackingNumber), [tn]);
  await pkg.markPickupScheduled(tn);
  queue = await pkg.listPickupsNeedingSchedule();
  assert.equal(queue.length, 0, "a proposed pickup is not re-queued");
});

test("a home-delivery package is tracked but never enters the pickup queue", async () => {
  await pkg.processShipmentEmail({ subject: "Shipped", body: "On its way to your home. Tracking TBA303384950001", description: "Soap" });
  assert.equal((await pkg.listActivePackages()).length, 1);
  assert.deepEqual(await pkg.listPickupsNeedingSchedule(), []);
});
