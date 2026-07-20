// READ-ONLY diagnostic: "did this package come through?" as a one-liner.
// Prints (1) the current tracked/active package list and (2) the most recent
// shipping-looking mail the heartbeat scan would see in the cos@ inbox, with the
// detection verdict for each. Makes no writes and sends nothing.
//
// Usage:
//   npm run packages:status              # last 25 shipping-looking messages
//   npm run packages:status -- --top 60  # widen the mail window
//
// Needs Graph creds (the npm script loads .env). Mirrors the heartbeat gate
// (skip self + family senders) so the "would-scan" view matches production.

import { recentShipmentMail } from "../src/channels/graph.js";
import { isShippingEmail, isDeliveryConfirmation, extractTrackingNumbers, extractRetailer, extractEta, listActivePackages, formatPackages } from "../src/packages.js";
import { isSelfAddress, isFamilyAddress } from "../src/guards.js";

const topArg = process.argv.indexOf("--top");
const top = topArg >= 0 ? Number(process.argv[topArg + 1]) || 25 : 25;

console.log("=== TRACKED (active / undelivered) ===");
try {
  const active = await listActivePackages();
  console.log(active.length ? formatPackages(active) : "(none tracked)");
} catch (e) {
  console.error("could not read the package store:", e.message);
}

console.log(`\n=== RECENT SHIPPING-LOOKING MAIL the scan would see (top ${top}) ===`);
let mail = [];
try {
  mail = await recentShipmentMail({ top });
} catch (e) {
  console.error("mailbox read failed (Graph creds?):", e.message);
  process.exit(1);
}

let shown = 0;
for (const m of mail) {
  const skip = isSelfAddress(m.from) ? "self" : isFamilyAddress(m.from) ? "family(skipped)" : "";
  const ship = isShippingEmail(m.subject, m.body);
  const deliv = isDeliveryConfirmation(m.subject, m.body);
  if (!ship && !deliv) continue;
  shown++;
  const tracking = extractTrackingNumbers(`${m.subject}\n${m.body}`).map((t) => t.trackingNumber);
  console.log(`\n[${m.receivedAt}] ${m.from}${skip ? ` <${skip}>` : ""}`);
  console.log(`  ${m.subject}`);
  console.log(`  shipping=${ship} delivered=${deliv} retailer=${JSON.stringify(extractRetailer(m.subject, m.body, m.from))} eta=${JSON.stringify(extractEta(m.subject, m.body))} tracking=${JSON.stringify(tracking)}`);
}
if (!shown) console.log("(no shipping-looking mail in the window)");
