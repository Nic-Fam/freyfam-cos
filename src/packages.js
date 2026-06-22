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

/** Upsert a tracked package (keeps the original addedAt). */
export async function addPackage({ trackingNumber, carrier, description = "", url = "" }, now = Date.now()) {
  if (!trackingNumber) return;
  const db = await load();
  const prev = db.items[trackingNumber];
  db.items[trackingNumber] = {
    trackingNumber,
    carrier: carrier || prev?.carrier || "Unknown",
    description: (description || prev?.description || "").slice(0, 300),
    url: url || prev?.url || "",
    addedAt: prev?.addedAt || new Date(now).toISOString(),
    delivered: prev?.delivered || false,
  };
  await save(db);
}

/** Mark a package delivered (creating the record if a delivery email is the first we see). */
export async function markDelivered(trackingNumber, now = Date.now()) {
  if (!trackingNumber) return;
  const db = await load();
  const prev = db.items[trackingNumber] || { trackingNumber, carrier: "Unknown", description: "", url: "", addedAt: new Date(now).toISOString() };
  db.items[trackingNumber] = { ...prev, delivered: true, deliveredAt: new Date(now).toISOString() };
  await save(db);
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
      return `${p.description || "Package"} — ${p.carrier} ${p.trackingNumber} (since ${date})${p.url ? `\n  ${p.url}` : ""}`;
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
  const tracked = [];
  const delivered = [];
  for (const n of found) {
    if (isDelivery) {
      await markDelivered(n.trackingNumber);
      delivered.push(n);
    } else {
      await addPackage({ ...n, description });
      tracked.push(n);
    }
  }
  return { isDelivery, found, tracked, delivered };
}
