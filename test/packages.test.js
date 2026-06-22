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
