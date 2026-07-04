import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

// ===========================================================================
// SSRF guard. Tools that fetch an ARBITRARY, possibly injection-supplied URL
// (browse_page -> channels/browser.js, fetch_document -> documents.js) must not
// be steerable at internal targets: cloud metadata (169.254.169.254), the
// loopback services (voice-server, BlueBubbles, the specialist harness on
// 127.0.0.1), or anything on the home LAN (RFC-1918). A prompt-injected email or
// web-search result that says "check this link" could otherwise pull an internal
// response back into the model/reply — worse for browse_page, which drives the
// signed-in Chrome profile.
//
// Two layers:
//   1. SYNCHRONOUS, always-on: reject non-http(s), literal private/loopback/
//      link-local IP hosts, and localhost names. No DNS, no network — this alone
//      blocks the metadata endpoint and the loopback/LAN-by-IP cases.
//   2. DNS resolution: resolve the hostname and reject if it maps to a blocked
//      address (catches names pointed at 127.0.0.1 / 10.x / etc). This FAILS OPEN
//      on a resolution error — the real fetch uses the same resolver, so a name we
//      cannot resolve cannot be fetched either; DNS-rebinding between our check and
//      the fetch is the residual risk (documented, acceptable for this threat model).
// ===========================================================================

function v4Blocked(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // malformed -> refuse
  const [a, b] = p;
  if (a === 0) return true;                       // 0.0.0.0/8 "this host"
  if (a === 10) return true;                      // 10.0.0.0/8 private
  if (a === 127) return true;                     // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true;        // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                       // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved (+255...)
  return false;
}

function v6Blocked(ip) {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;      // loopback / unspecified
  // IPv4-mapped/compat (::ffff:a.b.c.d) -> validate the embedded v4
  const m = s.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return v4Blocked(m[1]);
  if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true; // fe80::/10 link-local
  if (s.startsWith("fc") || s.startsWith("fd")) return true; // fc00::/7 unique-local
  if (s.startsWith("ff")) return true;             // ff00::/8 multicast
  return false;
}

/** True if a literal IP string is in a loopback/private/link-local/reserved range. */
export function isBlockedIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) return v4Blocked(ip);
  if (kind === 6) return v6Blocked(ip);
  return false; // not a literal IP
}

/**
 * Throw if `url` is unsafe to fetch (SSRF guard). Resolves DNS names and checks
 * every returned address. `resolve` is injectable for tests. Returns the parsed
 * URL on success.
 */
export async function assertPublicUrl(url, { resolve = lookup } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed, got ${u.protocol}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new Error(`URL has no host: ${url}`);
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error(`Refusing to fetch a loopback host: ${host}`);
  }
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`Refusing to fetch a private/loopback/link-local address: ${host}`);
    return u; // public literal IP
  }
  // DNS name: resolve and check. Fail OPEN on resolution error (see header).
  let addrs;
  try {
    addrs = await resolve(host, { all: true });
  } catch {
    return u; // cannot resolve -> cannot be fetched at an internal target either
  }
  for (const a of Array.isArray(addrs) ? addrs : [addrs]) {
    const ip = a?.address || a;
    if (ip && isBlockedIp(ip)) {
      throw new Error(`Refusing to fetch "${host}" — it resolves to a private/loopback address (${ip})`);
    }
  }
  return u;
}
