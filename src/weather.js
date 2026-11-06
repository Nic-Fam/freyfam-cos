import { MAPS, WEATHER } from "./config.js";
import { geocode } from "./commute.js";

// ===========================================================================
// Today's weather via the US National Weather Service (api.weather.gov). Free,
// no API key, US-only, authoritative. The chief exposes this as the
// `get_weather` tool and the morning digest uses it for each destination, so
// the digest no longer spends a metered web_search call on weather.
//
// NWS is a two-step API: GET /points/{lat},{lon} returns the forecast URL for
// that grid cell, then that URL returns the forecast periods. The points lookup
// is stable per location, so we cache it for the process lifetime. NWS requires
// a descriptive User-Agent (see config.WEATHER.userAgent). Geocoding reuses the
// commute module's Azure Maps geocoder (the digest asks for the same addresses).
// ===========================================================================

const NWS_BASE = "https://api.weather.gov";

// "lat,lon" (rounded) -> forecast URL. Grid cells are coarse, so rounding to 4
// decimals keeps nearby lookups on one cache entry without crossing cells.
const forecastUrlCache = new Map();

function nwsHeaders(userAgent) {
  // Accept geo+json per NWS docs; User-Agent is required or NWS returns 403.
  return { "User-Agent": userAgent, Accept: "application/geo+json" };
}

async function forecastUrlFor(lat, lon, userAgent) {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (forecastUrlCache.has(key)) return forecastUrlCache.get(key);
  const res = await fetch(`${NWS_BASE}/points/${key}`, { headers: nwsHeaders(userAgent) });
  if (!res.ok) throw new Error(`NWS points error: ${res.status}`);
  const data = await res.json();
  const url = data.properties?.forecast;
  if (!url) throw new Error("NWS returned no forecast URL for that location (US only)");
  forecastUrlCache.set(key, url);
  return url;
}

/**
 * Reduce an NWS forecast period to the fields the digest needs. Pure.
 * `probabilityOfPrecipitation.value` is 0-100 or null (NWS sends null, not 0,
 * when there is no chance), so we pass null through rather than coercing to 0.
 */
export function summarizePeriod(period) {
  return {
    label: period.name,                                   // "Today", "Tonight", "This Afternoon"
    temp: period.temperature,
    unit: period.temperatureUnit,                         // "F"
    shortForecast: period.shortForecast,                  // "Sunny", "Slight Chance Rain Showers"
    precipChance: period.probabilityOfPrecipitation?.value ?? null, // 0-100 or null
    isDaytime: period.isDaytime,
  };
}

/**
 * The forecast period that carries TODAY's high: the first daytime period that
 * starts on the same local date as the current one. Before dawn NWS leads with
 * "Overnight", a night period whose temperature is the LOW, and the 5am digest
 * runs then, so taking periods[0] reported the overnight low as the day's
 * weather. Once today's daytime periods are past ("Tonight"), the current period
 * stands. NWS startTime carries the location's own offset, so its first 10
 * characters are the local date. Pure.
 */
export function todayPeriod(periods) {
  const first = periods?.[0];
  if (!first) return null;
  const day = String(first.startTime || "").slice(0, 10);
  return (day && periods.find((p) => p.isDaytime && String(p.startTime || "").slice(0, 10) === day)) || first;
}

/**
 * Today's forecast for an address: the daytime period (so the temperature is
 * the high) while today still has one, else the current period. Throws on a
 * non-US / ungeocodable address.
 */
export async function getWeather(location, { mapsKey = MAPS.key, userAgent = WEATHER.userAgent } = {}) {
  if (!mapsKey) throw new Error("AZURE_MAPS_KEY is not configured");
  const { lat, lon } = await geocode(location, mapsKey);
  const url = await forecastUrlFor(lat, lon, userAgent);
  const res = await fetch(url, { headers: nwsHeaders(userAgent) });
  if (!res.ok) throw new Error(`NWS forecast error: ${res.status}`);
  const data = await res.json();
  const period = todayPeriod(data.properties?.periods);
  if (!period) throw new Error("NWS returned no forecast periods");
  return summarizePeriod(period);
}

/** One-line human summary. A daytime period's temperature is the high and a
 *  night period's the low, so say which. Precip shown only when meaningful
 *  (>=10%). Pure. */
export function formatWeather({ label, temp, unit, shortForecast, precipChance, isDaytime }) {
  const kind = isDaytime === true ? "high " : isDaytime === false ? "low " : "";
  const precip = precipChance != null && precipChance >= 10 ? `, ${precipChance}% precip` : "";
  return `${label}: ${shortForecast}, ${kind}${temp}°${unit}${precip}`;
}
