import { MAPS } from "./config.js";

// ===========================================================================
// Precise commute times via Azure Maps (ported from the legacy assistant).
// Two calls: geocode each endpoint, then a route with live traffic. Returns a
// small structured summary; the chief exposes this as the `commute_time` tool
// and the morning digest uses it for each person's route. Web search covers
// weather; this covers door-to-door ETA + delay, which search cannot.
// ===========================================================================

// Geocode results are stable, so cache them for the process lifetime.
const geocodeCache = new Map();

async function geocode(address, key) {
  if (geocodeCache.has(address)) return geocodeCache.get(address);
  const url = `https://atlas.microsoft.com/search/address/json?api-version=1.0&query=${encodeURIComponent(address)}&limit=1&subscription-key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Azure Maps geocode error: ${res.status}`);
  const data = await res.json();
  const pos = data.results?.[0]?.position;
  if (!pos) throw new Error(`Could not geocode: ${address}`);
  const coords = { lat: pos.lat, lon: pos.lon };
  geocodeCache.set(address, coords);
  return coords;
}

/** Format the raw route summary into a labeled traffic descriptor. Pure. */
export function summarizeLeg(summary) {
  const minutes = Math.round(summary.travelTimeInSeconds / 60);
  const delayMins = Math.round((summary.trafficDelayInSeconds || 0) / 60);
  const distanceMiles = Number((summary.lengthInMeters / 1609.34).toFixed(1));
  const trafficLabel = delayMins >= 15 ? "heavy traffic" : delayMins >= 5 ? "moderate traffic" : "light traffic";
  return { minutes, delayMins, distanceMiles, trafficLabel };
}

/**
 * Door-to-door driving time with live traffic between two addresses.
 * Returns { minutes, delayMins, distanceMiles, trafficLabel }.
 */
export async function getCommuteTime(origin, dest, { key = MAPS.key } = {}) {
  if (!key) throw new Error("AZURE_MAPS_KEY is not configured");
  const [o, d] = await Promise.all([geocode(origin, key), geocode(dest, key)]);
  const query = `${o.lat},${o.lon}:${d.lat},${d.lon}`;
  const url = `https://atlas.microsoft.com/route/directions/json?api-version=1.0&query=${encodeURIComponent(query)}&travelMode=car&traffic=true&subscription-key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Azure Maps route error: ${res.status}`);
  const data = await res.json();
  const leg = data.routes?.[0]?.legs?.[0];
  if (!leg) throw new Error("No route found");
  return summarizeLeg(leg.summary);
}

/** One-line human summary of a commute result. */
export function formatCommute({ minutes, delayMins, distanceMiles, trafficLabel }) {
  const delay = delayMins > 0 ? ` (+${delayMins} min delay)` : "";
  return `${minutes} min (${distanceMiles} mi), ${trafficLabel}${delay}`;
}
