// Frank's read-only monitors. He watches and flags; he never takes a control action
// (hard constraint). The active monitor is a breach-feed check (HaveIBeenPwned) for
// the family's email addresses; new exposures become high-severity findings + an
// owner alert. `securityPosture` summarizes the open findings for a glance / the
// digest. The scan runs from the heartbeat (Lloyd-side: it needs network + records
// findings + notifies — all things a remote specialist must not do).

import { createLogger } from "./log.js";

const log = createLogger("security-monitor");
const HIBP_KEY = () => process.env.HIBP_API_KEY;

/**
 * Check each email against HaveIBeenPwned. Key-gated (HIBP_API_KEY): with no key it
 * returns {skipped:true} so the monitor is inert until configured. 404 = clean;
 * 200 = a list of breach names. Best-effort per email. `fetchImpl` injectable for
 * tests; `delayMs` respects HIBP's rate limit between live calls.
 * @returns {Promise<{skipped:boolean, results:Array<{email,breaches?,error?}>}>}
 */
export async function checkBreaches(emails = [], { fetchImpl = fetch, apiKey = HIBP_KEY(), delayMs = 1600 } = {}) {
  if (!apiKey) return { skipped: true, reason: "no HIBP_API_KEY", results: [] };
  const results = [];
  for (const email of emails) {
    try {
      const res = await fetchImpl(
        `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=true`,
        { headers: { "hibp-api-key": apiKey, "user-agent": "freyfam-cos" } }
      );
      if (res.status === 404) results.push({ email, breaches: [] });
      else if (res.ok) results.push({ email, breaches: (await res.json()).map((x) => x.Name) });
      else results.push({ email, error: `HTTP ${res.status}` });
    } catch (e) {
      results.push({ email, error: String(e?.message || e) });
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); // HIBP rate limit
  }
  return { skipped: false, results };
}

/** New breach exposures vs the findings already logged. Pure. Returns [{email, breach, title}]. */
export function newBreachFindings(results = [], existingTitles = new Set()) {
  const out = [];
  for (const r of results || []) {
    for (const breach of r.breaches || []) {
      const title = `Breach exposure: ${r.email} in ${breach}`;
      if (!existingTitles.has(title)) out.push({ email: r.email, breach, title });
    }
  }
  return out;
}

/** One-glance summary of the OPEN findings, worst-first. Pure. */
export function securityPosture(findings = []) {
  const open = (findings || []).filter((f) => f && f.status !== "resolved" && f.status !== "closed");
  if (!open.length) return "Security posture: no open findings.";
  const order = ["critical", "high", "medium", "low", "info"];
  const bySev = {};
  for (const f of open) bySev[f.severity] = (bySev[f.severity] || 0) + 1;
  const counts = order.filter((s) => bySev[s]).map((s) => `${bySev[s]} ${s}`).join(", ");
  const urgent = open
    .filter((f) => f.severity === "critical" || f.severity === "high")
    .map((f) => `- ${f.severity.toUpperCase()}: ${f.title}`);
  return `Security posture: ${open.length} open (${counts}).` + (urgent.length ? `\nNeeds attention:\n${urgent.join("\n")}` : "");
}

export { log as _log };
