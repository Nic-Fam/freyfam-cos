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

test("extractEta pulls a human ETA; extractRetailer names the brand", () => {
  const body = "Estimated to Arrive on or Before\nMonday 07/27/2026\nby 9:00 PM";
  assert.equal(pkg.extractEta("Your package is on the way.", body), "Monday 07/27/2026 by 9:00 PM");
  assert.equal(pkg.extractEta("", "Arriving Monday, July 27"), "Monday, July 27");
  assert.equal(pkg.extractEta("", "no dates here"), "");
  assert.equal(pkg.extractRetailer("Your package is on the way.", "Your THE REALREAL package now has an estimated delivery date"), "The Realreal");
});

test("a retailer 'on the way' notice with NO tracking number is still tracked via ETA", async () => {
  // Real The RealReal email: says "on the way", carries only an ETA, no number.
  const subject = "Your package is on the way.";
  const body =
    "Your THE REALREAL package now has an estimated delivery date, and may be delivered by our trusted delivery partner.\n" +
    "Estimated to Arrive on or Before\nMonday 07/27/2026\nby 9:00 PM";
  assert.equal(pkg.isShippingEmail(subject, body), true, "on-the-way phrasing is a shipping notice");
  const r = await pkg.processShipmentEmail({ subject, body });
  assert.equal(r.found.length, 0, "no carrier tracking number in the email");
  assert.equal(r.tracked.length, 1, "recorded anyway, keyed by a synthetic id");
  assert.equal(r.eta, "Monday 07/27/2026 by 9:00 PM");

  const [p] = await pkg.listActivePackages();
  assert.equal(p.hasTracking, false);
  assert.equal(p.retailer, "The Realreal");
  assert.equal(p.eta, "Monday 07/27/2026 by 9:00 PM");
  assert.match(pkg.formatPackages([p]), /arriving Monday 07\/27\/2026 by 9:00 PM/);

  // Re-scanning the same notice must not create a duplicate.
  await pkg.processShipmentEmail({ subject, body });
  assert.equal((await pkg.listActivePackages()).length, 1, "trackingless notice dedupes on re-scan");
});

test("a plain marketing email with no ETA and no shipping subject mints no package", async () => {
  const r = await pkg.processShipmentEmail({ subject: "Weekend sale", body: "Enjoy free shipping on all orders!" });
  assert.equal(r.tracked.length, 0);
  assert.deepEqual(await pkg.listActivePackages(), []);
});

test("extractRetailer uses the sender domain and rejects nav-menu boilerplate", () => {
  // Real Amazon shipping email: the body's "Your Orders Your Account Buy Again
  // Your package" nav chrome must NOT become the retailer; the sender does.
  const navBody = "Your Orders Your Account Buy Again Your package was shipped!";
  assert.equal(pkg.extractRetailer("Shipped: \"Old Spice Men's...\"", navBody, "shipment-tracking@amazon.com"), "Amazon");
  assert.equal(pkg.extractRetailer("Shipped: \"Old Spice Men's...\"", navBody), "", "no sender + nav-junk body => no bogus retailer");
  assert.equal(pkg.retailerFromSender("no-reply@therealreal.com"), "The RealReal");
});

test("real Amazon trackingless shipping notice: tracked with a clean 'Amazon' label", async () => {
  // Verbatim shape of the 2026-07-19 cos@ email (Amazon uses no carrier number here).
  const subject = 'Shipped: "Old Spice Men\'s..."';
  const body = "Your Orders Your Account Buy Again Your package was shipped! Ordered Shipped Out for delivery Delivered Arriving today Nic - LA CRESCENTA, CA";
  const r = await pkg.processShipmentEmail({ subject, body, from: "shipment-tracking@amazon.com" });
  assert.equal(r.found.length, 0, "Amazon logistics email has no carrier tracking number");
  assert.equal(r.tracked.length, 1, "tracked via synthetic id on the shipping subject");
  assert.equal(r.retailer, "Amazon", "retailer from sender, not the nav-menu junk");
  const [p] = await pkg.listActivePackages();
  assert.equal(p.retailer, "Amazon");
  assert.equal(p.hasTracking, false);
});

test("Amazon Shipped then Delivered collapse into ONE package keyed by order #", async () => {
  const order = "114-0189185-5373077";
  const shipped = await pkg.processShipmentEmail({
    subject: 'Shipped: "Old Spice Men\'s..."',
    body: `Your package was shipped! Order # ${order} Arriving today`,
    from: "shipment-tracking@amazon.com",
  });
  assert.equal(shipped.tracked.length, 1);
  assert.equal(shipped.tracked[0].trackingNumber, `amzn:${order}`, "keyed by the Amazon order #");
  let active = await pkg.listActivePackages();
  assert.equal(active.length, 1);
  assert.equal(active[0].description, "Old Spice Men's", "readable item from the subject");
  assert.equal(active[0].retailer, "Amazon");

  // The Delivered notice (also trackingless, same order #) closes the SAME package.
  const del = await pkg.processShipmentEmail({
    subject: 'Delivered: "Old Spice Men\'s..."',
    body: `Delivered Order # ${order}`,
    from: "order-update@amazon.com",
  });
  assert.equal(del.delivered.length, 1);
  assert.equal(del.delivered[0].trackingNumber, `amzn:${order}`);
  active = await pkg.listActivePackages();
  assert.deepEqual(active, [], "one order in, one package out, delivered leaves the active list");
});

test("extractOrderNumber / extractSubjectItem pull the Amazon fields", () => {
  assert.equal(pkg.extractOrderNumber("Shipped", "Order # 114-0189185-5373077 today"), "114-0189185-5373077");
  assert.equal(pkg.extractOrderNumber("Shipped", "no order here"), "");
  assert.equal(pkg.extractSubjectItem('Shipped: "Old Spice Men\'s..."'), "Old Spice Men's");
  assert.equal(pkg.extractSubjectItem("Shipped: no quotes"), "");
});

test("a personal reply that merely says 'on the way' with a stray date mints no package", async () => {
  // Real cos@ false positive: a family reply about a visit, not a shipment.
  const subject = "Re: Visit Stewart and Val";
  const body = "It's an afternoon bbq so afternoon dinnerish time. So no eggs n things on the way out. The visit moved to Sunday, Aug 16.";
  const r = await pkg.processShipmentEmail({ subject, body, from: "Nic@Freyfam.com" });
  assert.equal(r.tracked.length, 0, "no shipping subject and not a known retailer sender => no phantom package");
  assert.deepEqual(await pkg.listActivePackages(), []);
});

test("a home-delivery package is tracked but never enters the pickup queue", async () => {
  await pkg.processShipmentEmail({ subject: "Shipped", body: "On its way to your home. Tracking TBA303384950001", description: "Soap" });
  assert.equal((await pkg.listActivePackages()).length, 1);
  assert.deepEqual(await pkg.listPickupsNeedingSchedule(), []);
});
