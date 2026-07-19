import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// Package / delivery tracking (ported from the legacy assistant). Forward a
// shipping or delivery email and Lloyd calls track_shipment: tracking numbers
// are extracted, new packages saved, and a delivery confirmation marks the
// package delivered. "Where's my package?" reads the active list. Stored locally
// (data/packages.json) instead of Azure Table, matching the COS store pattern.
// ===========================================================================

const STORE_PATH = () => process.env.PACKAGES_PATH || "./data/packages.json";
const MAX_TEXT = 50_000;

const cap = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1).toLowerCase()}` : s);

// Ordered by specificity — UPS/Amazon before the broad digit patterns.
const TRACKING_PATTERNS = [
  { carrier: "UPS", regex: /\b(1Z[A-Z0-9]{16})\b/gi, url: (n) => `https://www.ups.com/track?tracknum=${n}` },
  { carrier: "Amazon", regex: /\b(TBA\d{9,12}(?:US)?)\b/gi, url: () => "https://www.amazon.com/progress-tracker/package/" },
  { carrier: "USPS", regex: /\b(9[234]\d{18,20})\b/g, url: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  { carrier: "FedEx", regex: /\b(96\d{20}|\d{20})\b/g, url: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
];

/** Extract {carrier, trackingNumber, url} from text. Pure; deduped by number. */
export function extractTrackingNumbers(text) {
  if (!text || text.length > MAX_TEXT) return [];
  const found = [];
  const seen = new Set();
  for (const { carrier, regex, url } of TRACKING_PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const num = m[1];
      if (!seen.has(num)) {
        seen.add(num);
        found.push({ carrier, trackingNumber: num, url: url(num) });
      }
    }
  }
  return found;
}

// In-transit phrasing carriers/retailers actually use. Broad on purpose: some
// notices (e.g. The RealReal's "Your package is on the way", boutique/retailer
// mail) never say "shipped" and carry NO tracking number, only an ETA — those
// were slipping through the old "shipped|tracking|on its way" check entirely.
const SHIPPING_RE =
  /\b(shipped|has shipped|on (its|the|your) way|out for delivery|in transit|tracking number|tracking|arriving|will arrive|estimated (to arrive|delivery)|expected (to arrive|delivery)|has an estimated delivery)\b/;

/** True if the email looks like a shipping/in-transit notice. Pure. */
export function isShippingEmail(subject, body) {
  const text = `${subject || ""} ${body || ""}`.toLowerCase();
  return SHIPPING_RE.test(text);
}

/**
 * True ONLY when the email announces a COMPLETED delivery — not "will be
 * delivered", "out for delivery", etc. (those would otherwise mark everything
 * delivered). Trust a subject that says delivered; else require past-tense body
 * with no future/in-transit phrasing. Pure.
 */
export function isDeliveryConfirmation(subject, body) {
  const s = (subject || "").toLowerCase();
  const b = (body || "").toLowerCase();
  const subjectSays =
    /\b(delivered|delivery complete|delivery completed)\b/.test(s) &&
    !/\b(will be|to be|expected|estimated|out for|not yet|when|once|undelivered|cannot be|couldn't be|could not be)\s*\w*\s*delivered\b/.test(s);
  if (subjectSays) return true;
  const bodyPast = /\b(was|were|has been|have been|just) delivered\b/.test(b) || /\bdelivery (complete|completed)\b/.test(b);
  const bodyFuture = /\b(will be|to be|expected to be|estimated to be|scheduled to be|out for|not yet|when|once)\s*\w*\s*delivered\b/.test(b);
  return bodyPast && !bodyFuture;
}

// Whose package is it? Default to Nic unless the email names Shelli (the chosen
// policy 2026-06-25). Drives pickup urgency: Shelli's are ASAP. Pure.
export function attributeOwner(subject = "", body = "") {
  return /\bshell?i\b/i.test(`${subject} ${body}`) ? "shelli" : "nic";
}

// Pickup-location patterns: a parcel sent to a staffed counter / locker / hold,
// which the family must go COLLECT (vs a home delivery, which needs no event).
// Ordered most-specific first; the label is what the pickup calendar event names.
const PICKUP_PATTERNS = [
  { re: /\bthe ups store\b/i, label: "The UPS Store" },
  { re: /\bups (access point|store|location)\b/i, label: "UPS Access Point" },
  { re: /\bamazon (hub ?)?(locker|counter)\b/i, label: "Amazon Hub Locker" },
  { re: /\bfedex (office|onsite|hold|location|pickup)\b/i, label: "FedEx pickup location" },
  { re: /\b(usps|post office) (hold|pickup|for pickup)\b/i, label: "USPS pickup" },
  { re: /\bhold(ing)? (for|at) (a )?(pickup|location)\b/i, label: "Hold for pickup" },
  { re: /\b(available|ready|waiting) for (you to )?pick ?up\b/i, label: "Ready for pickup" },
  { re: /\bpick ?up (location|point|at the)\b/i, label: "Pickup location" },
];

/**
 * Detect whether a shipping email routes to a PICKUP location and, if so, a short
 * label for it (e.g. "The UPS Store"). Pure. The exact street address is often
 * absent from carrier emails, so we capture the provider label reliably and leave
 * the precise spot to the family's one known location / the tracking page.
 */
export function detectPickupLocation(subject = "", body = "") {
  const text = `${subject}\n${body}`;
  for (const { re, label } of PICKUP_PATTERNS) {
    if (re.test(text)) return { isPickup: true, location: label };
  }
  return { isPickup: false, location: "" };
}

const WEEKDAY = "(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*";
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";

/**
 * Best-effort delivery ETA from a shipping notice, as a short human label (e.g.
 * "Monday 07/27/2026 by 9:00 PM"). Retailer/carrier ETAs are the ONLY date many
 * notices carry (no tracking number), so this is what surfaces the package in the
 * morning digest's "Arriving:" line. Returns "" when nothing parseable. Pure.
 */
export function extractEta(subject = "", body = "") {
  const text = `${subject}\n${body}`.replace(/[ \t]+/g, " ");
  const time = (text.match(/\bby\s+(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))\b/i) || [])[1];
  const withTime = (d) => (time ? `${d} by ${time.replace(/\s+/g, " ").toUpperCase()}` : d);
  // "Monday 07/27/2026" / "Monday, 7/27" (weekday then a numeric date)
  let m = text.match(new RegExp(`\\b(${WEEKDAY})\\b[,\\s]*\\b(\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)\\b`, "i"));
  if (m) return withTime(`${cap(m[1])} ${m[2]}`);
  // "Monday, July 27" (weekday then a month name + day)
  m = text.match(new RegExp(`\\b(${WEEKDAY})\\b[,\\s]*\\b(${MONTH}\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?)`, "i"));
  if (m) return withTime(`${cap(m[1])}, ${m[2].replace(/\b\w/g, (c) => c.toUpperCase())}`);
  // Bare "July 27" / "Jul 27, 2026" near an arrive/deliver word
  m = text.match(new RegExp(`\\b(?:arrive|arriving|deliver(?:y|ed|ered)?|by|before|expected)\\b[^\\n]{0,24}?\\b(${MONTH}\\.?\\s+\\d{1,2}(?:,?\\s+\\d{4})?)`, "i"));
  if (m) return withTime(m[1].replace(/\b\w/g, (c) => c.toUpperCase()));
  // Bare numeric date near an arrive/deliver word
  m = text.match(/\b(?:arrive|arriving|deliver(?:y|ed|ered)?|by|before|expected)\b[^\n]{0,24}?\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i);
  if (m) return withTime(m[1]);
  return "";
}

/**
 * Best-effort retailer/brand name from a shipping notice, for a readable label
 * when there's no tracking number to show. Handles the common "Your <BRAND>
 * package ..." phrasing; falls back to "". Pure.
 */
export function extractRetailer(subject = "", body = "") {
  const m = `${subject}\n${body}`.match(/\byour\s+(.{2,40}?)\s+(?:package|order|shipment|parcel)\b/i);
  if (!m) return "";
  const name = m[1].replace(/\s+/g, " ").trim();
  // Title-case ALL-CAPS names ("THE REALREAL" -> "The Realreal"); leave mixed case.
  return /^[^a-z]*$/.test(name) ? name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : name;
}

// Stable synthetic id for a shipment we can't key by tracking number (retailer +
// ETA). Re-scanning the same notice collapses to the same key, so it dedupes.
function syntheticKey(retailer, eta, subject) {
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return `notrack:${slug(retailer) || "pkg"}:${slug(eta) || slug(subject) || "x"}`;
}

// --- local store ------------------------------------------------------------

async function load() {
  try {
    const d = JSON.parse(await readFile(STORE_PATH(), "utf8"));
    return d && typeof d === "object" && d.items ? d : { items: {} };
  } catch {
    return { items: {} };
  }
}
async function save(db) {
  await mkdir(dirname(STORE_PATH()), { recursive: true });
  await writeFile(STORE_PATH(), JSON.stringify(db, null, 2));
}

/** Upsert a tracked package (keeps the original addedAt + any pickup scheduling). */
export async function addPackage(
  { trackingNumber, carrier, description = "", url = "", owner, pickup, location, eta, retailer, hasTracking },
  now = Date.now()
) {
  if (!trackingNumber) return;
  const db = await load();
  const prev = db.items[trackingNumber];
  db.items[trackingNumber] = {
    trackingNumber,
    carrier: carrier || prev?.carrier || "Unknown",
    description: (description || prev?.description || "").slice(0, 300),
    url: url || prev?.url || "",
    owner: owner || prev?.owner || "nic",        // who it's for (drives pickup urgency)
    pickup: pickup ?? prev?.pickup ?? false,     // true => sent to a pickup location
    location: location || prev?.location || "",  // pickup location label, if any
    eta: eta || prev?.eta || "",                 // human ETA label (retailer notices often have only this)
    retailer: retailer || prev?.retailer || "",  // brand name, for a readable label when there's no number
    hasTracking: hasTracking ?? prev?.hasTracking ?? true, // false => synthetic id, no carrier tracking number
    pickupScheduledAt: prev?.pickupScheduledAt || null, // set once we propose a pickup event
    addedAt: prev?.addedAt || new Date(now).toISOString(),
    delivered: prev?.delivered || false,
  };
  await save(db);
}

/** Packages awaiting a pickup event: active, at a pickup location, not yet proposed. */
export async function listPickupsNeedingSchedule() {
  const db = await load();
  return Object.values(db.items).filter((p) => !p.delivered && p.pickup && !p.pickupScheduledAt);
}

/** Mark that a pickup calendar event has been PROPOSED, so we don't re-propose it. */
export async function markPickupScheduled(trackingNumber, now = Date.now()) {
  const db = await load();
  const p = db.items[trackingNumber];
  if (!p) return;
  p.pickupScheduledAt = new Date(now).toISOString();
  await save(db);
}

/**
 * Mark a package delivered (creating the record if a delivery email is the first
 * we see). `opts.pickup`/`opts.location` capture a pickup-location delivery (e.g.
 * the UPS Store) even when the delivery email is the first sighting, so the
 * afternoon pickup digest can surface it. Existing flags are preserved when not
 * provided.
 */
export async function markDelivered(trackingNumber, now = Date.now(), { pickup, location } = {}) {
  if (!trackingNumber) return;
  const db = await load();
  const prev = db.items[trackingNumber] || { trackingNumber, carrier: "Unknown", description: "", url: "", addedAt: new Date(now).toISOString() };
  db.items[trackingNumber] = {
    ...prev,
    delivered: true,
    deliveredAt: new Date(now).toISOString(),
    pickup: pickup || prev.pickup || false,
    location: location || prev.location || "",
  };
  await save(db);
}

/** Delivered packages that went to a pickup location (e.g. the UPS Store), newest delivery first. */
export async function listDeliveredPickups() {
  const db = await load();
  return Object.values(db.items)
    .filter((p) => p.delivered && p.pickup)
    .sort((a, b) => String(b.deliveredAt || "").localeCompare(String(a.deliveredAt || "")));
}

/** Active (undelivered) packages, newest first. */
export async function listActivePackages() {
  const db = await load();
  return Object.values(db.items)
    .filter((p) => !p.delivered)
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
}

/** Human summary of active packages. */
export function formatPackages(packages) {
  if (!packages || !packages.length) return "No packages currently being tracked.";
  return packages
    .map((p) => {
      const date = p.addedAt ? new Date(p.addedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "unknown";
      const who = p.owner ? `${p.owner[0].toUpperCase()}${p.owner.slice(1)}: ` : "";
      const label = p.description || (p.retailer ? `${p.retailer} package` : "Package");
      // With a real tracking number show "carrier number"; trackingless shows just the carrier/brand.
      const dupCarrier = p.carrier && label.toLowerCase().includes(p.carrier.toLowerCase());
      const id = p.hasTracking === false ? (p.carrier && p.carrier !== "Unknown" && !dupCarrier ? ` — ${p.carrier}` : "") : ` — ${p.carrier} ${p.trackingNumber}`;
      const pickup = p.pickup ? ` [pickup${p.location ? ` @ ${p.location}` : ""}]` : "";
      const when = p.eta ? ` (arriving ${p.eta})` : ` (since ${date})`;
      return `${who}${label}${id}${pickup}${when}${p.url ? `\n  ${p.url}` : ""}`;
    })
    .join("\n");
}

/**
 * Process one shipping/delivery email end to end: extract tracking numbers, then
 * either mark delivered (delivery confirmation) or track them (shipping notice).
 * Returns what changed so the caller can give the family a heads-up.
 */
export async function processShipmentEmail({ subject = "", body = "", description = "" } = {}) {
  const found = extractTrackingNumbers(`${subject}\n${body}`);
  const isDelivery = isDeliveryConfirmation(subject, body);
  const owner = attributeOwner(subject, body);
  const { isPickup, location } = detectPickupLocation(subject, body);
  const eta = extractEta(subject, body);
  const retailer = extractRetailer(subject, body);
  const tracked = [];
  const delivered = [];
  for (const n of found) {
    if (isDelivery) {
      await markDelivered(n.trackingNumber, Date.now(), { pickup: isPickup, location });
      delivered.push(n);
    } else {
      await addPackage({ ...n, description, owner, pickup: isPickup, location, eta, retailer });
      tracked.push(n);
    }
  }
  // Trackingless in-transit notice (retailer mail like The RealReal carries an ETA
  // but no carrier number). Record it under a stable synthetic id so it still shows
  // in the digest / active list. Gated: only when there's a real shipping signal —
  // an ETA we parsed, or a shipping phrase in the SUBJECT — so marketing mail that
  // merely mentions "free shipping" doesn't mint phantom packages.
  const subjectIsShipping = SHIPPING_RE.test(String(subject).toLowerCase());
  if (!isDelivery && found.length === 0 && (eta || subjectIsShipping)) {
    const trackingNumber = syntheticKey(retailer, eta, subject);
    await addPackage({
      trackingNumber,
      carrier: retailer || "Retailer",
      description: description || (retailer ? `${retailer} package` : "Package"),
      owner, pickup: isPickup, location, eta, retailer, hasTracking: false,
    });
    tracked.push({ trackingNumber, carrier: retailer || "Retailer", eta, hasTracking: false });
  }
  return { isDelivery, found, tracked, delivered, owner, pickup: isPickup, location, eta, retailer };
}
