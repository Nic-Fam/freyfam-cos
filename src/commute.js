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

// Exported so the weather tool can reuse the same geocoder + cache: NWS keys
// off lat/lon, and the digest asks for weather at the very same addresses.
export async function geocode(address, key, fetchImpl = fetch) {
  if (geocodeCache.has(address)) return geocodeCache.get(address);
  const url = `https://atlas.microsoft.com/search/address/json?api-version=1.0&query=${encodeURIComponent(address)}&limit=1&subscription-key=${key}`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`Azure Maps geocode error: ${res.status}`);
  const data = await res.json();
  let pos = data.results?.[0]?.position;
  if (!pos) {
    // Calendar locations are often a place NAME ("Glendale Dental", "Union
    // Pasadena"), which the address geocoder can't resolve. Fuzzy search covers
    // points of interest as well as addresses.
    const fuzzy = `https://atlas.microsoft.com/search/fuzzy/json?api-version=1.0&query=${encodeURIComponent(address)}&countrySet=US&limit=1&subscription-key=${key}`;
    const r2 = await fetchImpl(fuzzy);
    if (r2.ok) pos = (await r2.json()).results?.[0]?.position;
  }
  if (!pos) throw new Error(`Could not geocode: ${address}`);
  const coords = { lat: pos.lat, lon: pos.lon };
  geocodeCache.set(address, coords);
  return coords;
}

/** Format the raw route summary into a labeled traffic descriptor. Pure.
 *  The delay is measured against FREE-FLOW time when the API reports it
 *  (computeTravelTimeFor=all). That is the only delay that means anything for a
 *  future departure: Azure's trafficDelayInSeconds covers live incidents only and
 *  is always 0 for a route planned with a future departAt/arriveAt. */
export function summarizeLeg(summary) {
  const minutes = Math.round(summary.travelTimeInSeconds / 60);
  const freeFlow = Number.isFinite(summary.noTrafficTravelTimeInSeconds) ? summary.noTrafficTravelTimeInSeconds : null;
  const delaySec = freeFlow != null
    ? Math.max(0, summary.travelTimeInSeconds - freeFlow)
    : summary.trafficDelayInSeconds || 0;
  const delayMins = Math.round(delaySec / 60);
  const distanceMiles = Number((summary.lengthInMeters / 1609.34).toFixed(1));
  const trafficLabel = delayMins >= 15 ? "heavy traffic" : delayMins >= 5 ? "moderate traffic" : "light traffic";
  return { minutes, delayMins, distanceMiles, trafficLabel };
}

// ---------------------------------------------------------------------------
// TIME-AWARE routing (2026-10-26). The old call priced every route at the moment
// it was made, on live traffic. The morning digest runs at 6am, so an 8:15
// commute was quoted on empty 6am roads, and leave_by for a 5pm appointment used
// whatever traffic happened to exist when the family asked. Azure Maps can plan
// against PREDICTED traffic for a future time (historic + live model): pass
// arriveAt (when you need to be there) or departAt. These helpers do that, in the
// family timezone, so a wall-clock "09:30" means 9:30 in La Crescenta.
// ---------------------------------------------------------------------------

const FAMILY_TZ = process.env.FAMILY_TZ || "America/Los_Angeles";

/** UTC offset (minutes) of `tz` at a given instant, e.g. -420 for PDT. */
function offsetMinutes(instantMs, tz) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(new Date(instantMs))
    .find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/**
 * Turn a wall-clock time in the family timezone into a real instant.
 * Accepts "2026-10-26T08:15", "2026-10-26T08:15:00(.0000000)", or a string that
 * already carries an offset/Z (returned as that instant). DST-safe. Pure.
 * @returns {Date|null}
 */
export function zonedInstant(wall, tz = FAMILY_TZ) {
  const s = String(wall || "").trim();
  if (!s) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Two passes settle DST transitions (the offset at the guess can differ from the
  // offset at the true instant by an hour).
  let t = asUtc - offsetMinutes(asUtc, tz) * 60000;
  t = asUtc - offsetMinutes(t, tz) * 60000;
  return new Date(t);
}

/** RFC 3339 with the family-timezone offset, the form Azure Maps wants. Pure. */
export function rfc3339InTz(date, tz = FAMILY_TZ) {
  const ms = date.getTime();
  const off = offsetMinutes(ms, tz);
  const local = new Date(ms + off * 60000);
  const pad = (n) => String(n).padStart(2, "0");
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** Short family-local clock label for an instant: "8:05 AM". Pure. */
export function clockLabel(date, tz = FAMILY_TZ) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(date);
}

/**
 * Route one leg with traffic predicted for WHEN the trip happens.
 * At most one of `arriveAt` / `departAt` (Date); with neither, the route is
 * priced for right now on live traffic. If the API rejects arriveAt (HTTP 400),
 * falls back to two departAt passes (guess, then correct), which every API
 * version supports. `fetchImpl` injectable for tests.
 * @returns {Promise<{minutes:number, delayMins:number, distanceMiles:number, trafficLabel:string,
 *                    departAt:Date, arriveAt:Date, basis:"predicted"|"live"}>}
 */
export async function routeLeg(origin, dest, { arriveAt = null, departAt = null, key = MAPS.key, fetchImpl = fetch, now = new Date(), tz = FAMILY_TZ } = {}) {
  if (!key) throw new Error("AZURE_MAPS_KEY is not configured");
  // A time already (nearly) past can't be planned for; price it as leaving now.
  if (arriveAt && arriveAt.getTime() <= now.getTime() + 5 * 60000) arriveAt = null;
  if (departAt && departAt.getTime() <= now.getTime() + 60000) departAt = null;
  const [o, d] = await Promise.all([geocode(origin, key, fetchImpl), geocode(dest, key, fetchImpl)]);
  const query = `${o.lat},${o.lon}:${d.lat},${d.lon}`;
  const base = `https://atlas.microsoft.com/route/directions/json?api-version=1.0&query=${encodeURIComponent(query)}&travelMode=car&traffic=true&computeTravelTimeFor=all&subscription-key=${key}`;
  const call = async (extra) => {
    const res = await fetchImpl(base + extra);
    if (!res.ok) {
      const err = new Error(`Azure Maps route error: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    const summary = data.routes?.[0]?.legs?.[0]?.summary || data.routes?.[0]?.summary;
    if (!summary) throw new Error("No route found");
    return summary;
  };
  const shape = (summary, basis) => {
    const leg = summarizeLeg(summary);
    const valid = (x) => (x && !Number.isNaN(x.getTime()) ? x : null);
    const dep0 = valid(summary.departureTime ? new Date(summary.departureTime) : null);
    const arr0 = valid(summary.arrivalTime ? new Date(summary.arrivalTime) : null);
    const depAt = dep0 || (arr0 ? new Date(arr0.getTime() - leg.minutes * 60000) : now);
    const arrAt = arr0 || new Date(depAt.getTime() + leg.minutes * 60000);
    return { ...leg, departAt: depAt, arriveAt: arrAt, basis };
  };

  if (arriveAt) {
    try {
      return shape(await call(`&arriveAt=${encodeURIComponent(rfc3339InTz(arriveAt, tz))}`), "predicted");
    } catch (e) {
      if (e.status !== 400) throw e;
      // Fallback: depart at a guess, then correct the guess by the predicted time.
      const first = await call(`&departAt=${encodeURIComponent(rfc3339InTz(new Date(arriveAt.getTime() - 40 * 60000), tz))}`);
      let dep = new Date(arriveAt.getTime() - first.travelTimeInSeconds * 1000);
      if (dep.getTime() <= now.getTime() + 60000) dep = null;
      const second = dep ? await call(`&departAt=${encodeURIComponent(rfc3339InTz(dep, tz))}`) : await call("");
      const out = shape(second, dep ? "predicted" : "live");
      // Re-anchor on the requested arrival so leave-by math is exact.
      return { ...out, arriveAt, departAt: new Date(arriveAt.getTime() - out.minutes * 60000) };
    }
  }
  if (departAt) return shape(await call(`&departAt=${encodeURIComponent(rfc3339InTz(departAt, tz))}`), "predicted");
  return shape(await call(""), "live");
}

/**
 * Door-to-door driving time between two addresses. With `arriveBy` or `departAt`
 * (a wall-clock time in the family timezone, or any ISO instant) the route is
 * priced on PREDICTED traffic for that time; with neither, on live traffic now.
 * Returns { minutes, delayMins, distanceMiles, trafficLabel, departAt, arriveAt, basis }.
 */
export async function getCommuteTime(origin, dest, { key = MAPS.key, arriveBy = null, departAt = null, fetchImpl = fetch, now = new Date() } = {}) {
  return routeLeg(origin, dest, {
    key,
    fetchImpl,
    now,
    arriveAt: arriveBy ? zonedInstant(arriveBy) : null,
    departAt: departAt ? zonedInstant(departAt) : null,
  });
}

/** One-line human summary of a commute result. */
export function formatCommute({ minutes, delayMins, distanceMiles, trafficLabel, departAt, arriveAt, basis }) {
  const delay = delayMins > 0 ? ` (+${delayMins} min vs. empty roads)` : "";
  const when = basis === "predicted" && departAt && arriveAt
    ? `; leave ${clockLabel(departAt)}, arrive ${clockLabel(arriveAt)} (predicted traffic)`
    : "";
  return `${minutes} min (${distanceMiles} mi), ${trafficLabel}${delay}${when}`;
}
