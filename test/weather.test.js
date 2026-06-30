import { test, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { summarizePeriod, formatWeather, getWeather } from "../src/weather.js";

// --- pure helpers ----------------------------------------------------------

test("summarizePeriod pulls the fields the digest needs", () => {
  const r = summarizePeriod({
    name: "Today", temperature: 78, temperatureUnit: "F",
    shortForecast: "Sunny", probabilityOfPrecipitation: { value: 0 }, isDaytime: true,
  });
  assert.deepEqual(r, { label: "Today", temp: 78, unit: "F", shortForecast: "Sunny", precipChance: 0, isDaytime: true });
});

test("summarizePeriod passes a null precip chance through (NWS sends null, not 0)", () => {
  const r = summarizePeriod({ name: "Tonight", temperature: 60, temperatureUnit: "F", shortForecast: "Clear", probabilityOfPrecipitation: { value: null }, isDaytime: false });
  assert.equal(r.precipChance, null);
});

test("formatWeather shows precip only when meaningful (>=10%)", () => {
  assert.equal(formatWeather({ label: "Today", temp: 78, unit: "F", shortForecast: "Sunny", precipChance: 0 }), "Today: Sunny, 78°F");
  assert.equal(formatWeather({ label: "Today", temp: 64, unit: "F", shortForecast: "Rain Likely", precipChance: 70 }), "Today: Rain Likely, 64°F, 70% precip");
  assert.equal(formatWeather({ label: "Today", temp: 64, unit: "F", shortForecast: "Cloudy", precipChance: null }), "Today: Cloudy, 64°F");
});

// --- two-step NWS flow against a stub server -------------------------------

let server, base, hits;

before(async () => {
  hits = { points: 0, forecast: 0 };
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/geo+json");
    if (req.url.startsWith("/points/")) {
      hits.points++;
      res.end(JSON.stringify({ properties: { forecast: `${base}/forecast` } }));
      return;
    }
    if (req.url === "/forecast") {
      hits.forecast++;
      res.end(JSON.stringify({ properties: { periods: [
        { name: "Today", temperature: 75, temperatureUnit: "F", shortForecast: "Partly Sunny", probabilityOfPrecipitation: { value: 20 }, isDaytime: true },
        { name: "Tonight", temperature: 58, temperatureUnit: "F", shortForecast: "Clear", probabilityOfPrecipitation: { value: 0 }, isDaytime: false },
      ] } }));
      return;
    }
    res.writeHead(404).end("nope");
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("getWeather geocodes, resolves the forecast URL, and returns the first period", async () => {
  // Stub the geocoder by overriding global fetch only for the Azure Maps host:
  // simplest is to inject a fake mapsKey and point NWS at our stub. We bypass the
  // real geocode by monkeypatching it via a wrapper module is overkill; instead we
  // drive getWeather with a stubbed points base by overriding fetch for atlas.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes("atlas.microsoft.com")) {
      return new Response(JSON.stringify({ results: [{ position: { lat: 34.1, lon: -118.3 } }] }), { headers: { "content-type": "application/json" } });
    }
    if (u.startsWith(`${base}/points/`) || u === `${base}/forecast`) return realFetch(url, opts);
    // NWS real host -> redirect to our stub points endpoint
    if (u.startsWith("https://api.weather.gov/points/")) {
      const tail = u.slice("https://api.weather.gov".length);
      return realFetch(`${base}${tail}`, opts);
    }
    return realFetch(url, opts);
  };
  try {
    const w = await getWeather("123 Test St, Glendale CA", { mapsKey: "fake-key", userAgent: "test-ua" });
    assert.deepEqual(w, { label: "Today", temp: 75, unit: "F", shortForecast: "Partly Sunny", precipChance: 20, isDaytime: true });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("getWeather throws a clear error when the Maps key is missing", async () => {
  await assert.rejects(() => getWeather("anywhere", { mapsKey: "" }), /AZURE_MAPS_KEY is not configured/);
});
