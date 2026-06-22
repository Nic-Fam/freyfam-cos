import { SEARCH } from "./config.js";
import { recordBraveQuery } from "./cost.js";

// ===========================================================================
// Read-only web search (workstream N). Distinct from browse_page, which reads
// ONE known URL: search FINDS the URLs. Natural pairing is search -> pick the
// best hit -> browse_page it. Provider-agnostic with Brave as the default
// backend; degrades to a clear "unavailable" message when no key is set, the
// same graceful-degrade pattern as the browser and cost watchdog.
//
// Privacy: the query text leaves the network to the provider, the same trade as
// Twilio/Slack. Granting is per-agent (see agents/tools.js + orchestrator.js):
// chief + resale always, security scoped, finance never.
// ===========================================================================

// Map a Brave web-search payload to our small, stable result shape.
export function mapBraveResults(payload, count) {
  const results = payload?.web?.results || [];
  return results.slice(0, count).map((r) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || "",
  }));
}

/**
 * Run a web search. Returns [{title, url, snippet}] (capped). Throws a clear
 * Error when no provider key is configured so the tool handler can surface it.
 * `fetchImpl` is injectable for tests.
 */
export async function webSearch(query, { count = SEARCH.count, fetchImpl = fetch } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  if (SEARCH.provider !== "brave") throw new Error(`unsupported search provider "${SEARCH.provider}"`);
  if (!SEARCH.key) throw new Error("search unavailable: BRAVE_SEARCH_KEY is not set");

  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`;
  const res = await fetchImpl(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": SEARCH.key },
  });
  if (!res.ok) throw new Error(`Brave search error: ${res.status}`);
  const results = mapBraveResults(await res.json(), count);
  await recordBraveQuery(); // meter this billable query for the cost watchdog (no-op unless enabled)
  return results;
}
