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

/** True if the email looks like a shipping/in-transit notice. Pure. */
export function isShippingEmail(subject, body) {
  const text = `${subject || ""} ${body || ""}`.toLowerCase();
  return /\b(shipped|tracking|on its way|out for delivery|in transit|has shipped)\b/.test(text);
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
  { trackingNumber, carrier, description = "", url = "", owner, pickup, location },
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
      const pickup = p.pickup ? ` [pickup${p.location ? ` @ ${p.location}` : ""}]` : "";
      return `${who}${p.description || "Package"} — ${p.carrier} ${p.trackingNumber}${pickup} (since ${date})${p.url ? `\n  ${p.url}` : ""}`;
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
  const tracked = [];
  const delivered = [];
  for (const n of found) {
    if (isDelivery) {
      await markDelivered(n.trackingNumber, Date.now(), { pickup: isPickup, location });
      delivered.push(n);
    } else {
      await addPackage({ ...n, description, owner, pickup: isPickup, location });
      tracked.push(n);
    }
  }
  return { isDelivery, found, tracked, delivered, owner, pickup: isPickup, location };
}
