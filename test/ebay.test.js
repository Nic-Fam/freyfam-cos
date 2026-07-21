import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { ebaySearch, getAppToken, mapEbayItem, _resetEbayAuth } from "../src/ebay.js";

const CFG = { clientId: "app-id", clientSecret: "cert-id", base: "https://api.test", marketplaceId: "EBAY_US" };
const jsonRes = (obj) => ({ ok: true, status: 200, json: async () => obj });

beforeEach(() => _resetEbayAuth());

test("mapEbayItem reduces an itemSummary to our standard row", () => {
  const r = mapEbayItem({ title: "Tabi 39", itemWebUrl: "https://ebay.com/itm/1", price: { value: "320.00", currency: "USD" }, condition: "Pre-owned" });
  assert.deepEqual(r, { title: "Tabi 39", url: "https://ebay.com/itm/1", snippet: "$320 - Pre-owned", price: 320, image: "" });
  // The listing photo is carried through for the resale vision assessment.
  const withImg = mapEbayItem({ title: "Tabi", itemWebUrl: "https://ebay.com/itm/2", image: { imageUrl: "https://i.ebayimg.com/x.jpg" } });
  assert.equal(withImg.image, "https://i.ebayimg.com/x.jpg");
});

test("ebaySearch returns [] (no throw) when creds are unset", async () => {
  const out = await ebaySearch("anything", { cfg: { ...CFG, clientId: "", clientSecret: "" } });
  assert.deepEqual(out, []);
});

test("ebaySearch authenticates, searches, maps, and drops urless items", async () => {
  let tokenCalls = 0, searchUrl = null;
  const fetchImpl = async (url, opts) => {
    if (url.includes("/identity/v1/oauth2/token")) {
      tokenCalls++;
      assert.match(opts.headers.Authorization, /^Basic /);
      return jsonRes({ access_token: "tok-123", expires_in: 7200 });
    }
    if (url.includes("/buy/browse/v1/item_summary/search")) {
      searchUrl = url;
      assert.equal(opts.headers.Authorization, "Bearer tok-123");
      assert.equal(opts.headers["X-EBAY-C-MARKETPLACE-ID"], "EBAY_US");
      return jsonRes({ itemSummaries: [
        { title: "Tabi 39", itemWebUrl: "https://ebay.com/itm/1", price: { value: "320.00" }, condition: "Pre-owned" },
        { title: "no url here", price: { value: "10" } },
      ] });
    }
    return { ok: false, status: 404 };
  };
  const out = await ebaySearch("Margiela Tabi", { count: 5, maxPrice: 350, cfg: CFG, fetchImpl });
  assert.equal(out.length, 1, "the item without a url is dropped");
  assert.equal(out[0].url, "https://ebay.com/itm/1");
  assert.equal(out[0].price, 320);
  assert.match(decodeURIComponent(searchUrl), /price:\[\.\.350\],priceCurrency:USD/, "maxPrice becomes a server-side filter");
  assert.match(searchUrl, /limit=5/);
});

test("getAppToken caches the token across calls (one auth round-trip)", async () => {
  let tokenCalls = 0;
  const fetchImpl = async (url) => {
    if (url.includes("/oauth2/token")) { tokenCalls++; return jsonRes({ access_token: "t", expires_in: 7200 }); }
    return jsonRes({ itemSummaries: [] });
  };
  await getAppToken({ cfg: CFG, fetchImpl });
  await getAppToken({ cfg: CFG, fetchImpl });
  assert.equal(tokenCalls, 1, "second call reuses the cached token");
});

test("ebaySearch throws on a non-ok search response", async () => {
  const fetchImpl = async (url) => url.includes("/oauth2/token")
    ? jsonRes({ access_token: "t", expires_in: 7200 })
    : { ok: false, status: 500 };
  await assert.rejects(() => ebaySearch("x", { cfg: CFG, fetchImpl }), /eBay search error: 500/);
});
