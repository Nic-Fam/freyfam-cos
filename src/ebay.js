import { EBAY } from "./config.js";
import { createLogger } from "./log.js";

// ===========================================================================
// eBay Browse API source for resale saved-searches. eBay is the one hunt site
// with a real, FREE official API, so it replaces metered Brave web search for
// eBay-targeted searches (the weather->NWS pattern, applied to resale).
//
// Auth is OAuth2 client-credentials: POST the App ID + Cert ID (Basic auth) for
// a ~2h application token, cached in-process until just before expiry. Search is
// then a plain GET with a Bearer token. Price cap is a SERVER-SIDE filter, which
// is stricter and cheaper than folding "under $N" into a text query (what Brave
// has to do). Returns our standard [{title,url,snippet,price}] shape.
//
// Graceful degrade: with no creds configured, ebaySearch returns [] (logged
// once) so the source router falls back to Brave instead of throwing.
// ===========================================================================

const log = createLogger("ebay");
const OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";

// Cached application token: { token, expiresAt(ms) }. Module-level so repeated
// saved-search runs reuse one token instead of re-authing every call.
let _auth = null;

/** Test/seam hook: clear the cached token so a fresh auth round-trips. */
export function _resetEbayAuth() {
  _auth = null;
}

function isConfigured(cfg) {
  return Boolean(cfg.clientId && cfg.clientSecret);
}

/**
 * Fetch (and cache) an application access token via client-credentials. Reused
 * until 60s before expiry. `fetchImpl`/`now` injectable for tests.
 */
export async function getAppToken({ cfg = EBAY, fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (_auth && _auth.expiresAt > now() + 60_000) return _auth.token;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetchImpl(`${cfg.base}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(OAUTH_SCOPE)}`,
  });
  if (!res.ok) throw new Error(`eBay token error: ${res.status}`);
  const data = await res.json();
  if (!data.access_token) throw new Error("eBay token response had no access_token");
  _auth = { token: data.access_token, expiresAt: now() + Number(data.expires_in || 7200) * 1000 };
  return _auth.token;
}

/** Map an eBay itemSummary to our standard result row. Pure. */
export function mapEbayItem(it) {
  const price = it?.price?.value != null ? Number(it.price.value) : null;
  const cond = it?.condition ? `${it.condition}` : "";
  const priceStr = price != null ? `$${price}` : "";
  return {
    title: it?.title || "",
    url: it?.itemWebUrl || "",
    snippet: [priceStr, cond].filter(Boolean).join(" - "),
    price: Number.isFinite(price) ? price : null,
  };
}

/**
 * Search eBay for a query. Returns [{title,url,snippet,price}] (capped at
 * `count`). maxPrice becomes a server-side price filter. Returns [] (no throw)
 * when creds are unset, so the router can fall back to Brave.
 * `fetchImpl` injectable for tests.
 */
export async function ebaySearch(query, { count = 10, maxPrice = null, cfg = EBAY, fetchImpl = fetch } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  if (!isConfigured(cfg)) {
    log.info("eBay source skipped: EBAY_CLIENT_ID/SECRET not set");
    return [];
  }
  const token = await getAppToken({ cfg, fetchImpl });
  const params = new URLSearchParams({ q, limit: String(count) });
  // eBay range filter: price:[..N] = up to N. Currency must accompany a price filter.
  if (maxPrice != null) params.set("filter", `price:[..${Number(maxPrice)}],priceCurrency:USD`);
  const res = await fetchImpl(`${cfg.base}/buy/browse/v1/item_summary/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": cfg.marketplaceId,
    },
  });
  if (!res.ok) throw new Error(`eBay search error: ${res.status}`);
  const data = await res.json();
  return (data.itemSummaries || []).slice(0, count).map(mapEbayItem).filter((r) => r.url);
}
