// Internet uplink detector. The Asus dual-WAN fails over from the primary AT&T
// fiber (AS7018) to a Starlink satellite STANDBY when the fiber trunk drops. That
// standby is deliberately throttled (~300 kB/s) to stay a true backup, so on
// failover the household needs a human to activate full Starlink service. On
// failover the public egress ASN flips to SpaceX Starlink (AS14593); reading the
// public IP + ASN is a tiny (~1 KB) request that still gets through the throttled
// link, so it's a low-data, reliable failover signal.
//
// READ-ONLY + ADVISORY. This only OBSERVES the uplink and returns text. Sending an
// alert is Lloyd's job (specialists never have an outbound channel). No control
// action anywhere — nothing here touches the router or the link.

const STARLINK_ASN = process.env.STARLINK_ASN || "AS14593";
const STARLINK_RE = /starlink|spacex/i;
// The normal primary ASN (AT&T = AS7018 in this household). Optional: if set,
// egress on any OTHER asn is treated as "off primary" even when we can't name it.
const PRIMARY_ASN = process.env.PRIMARY_WAN_ASN || "AS7018";

// Fetch the public egress IP + ASN/org from a lightweight service, with a plain
// ip-only fallback. Returns { ip, asn, org, ok }. ok:false means BOTH checks
// failed, which usually means the link is fully down (not just throttled).
export async function currentUplink({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const withTimeout = async (url, parse) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await parse(res);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const primary = await withTimeout("https://ipinfo.io/json", async (res) => {
    const d = await res.json();
    const org = d.org || "";
    const asn = (org.match(/^AS\d+/) || [""])[0];
    return { ip: d.ip || "", asn, org, ok: true };
  });
  if (primary) return primary;

  // Fallback: Cloudflare trace gives the IP (no ASN) — enough to know the link is up.
  const fallback = await withTimeout("https://www.cloudflare.com/cdn-cgi/trace", async (res) => {
    const txt = await res.text();
    const ip = (txt.match(/^ip=(.+)$/m) || [])[1] || "";
    return ip ? { ip, asn: "", org: "", ok: true, partial: true } : null;
  });
  return fallback || { ip: "", asn: "", org: "", ok: false };
}

// Classify a currentUplink() result. onStarlink = we're on the satellite backup;
// onBackup = onStarlink OR (we know the primary asn and we're not on it).
export function classifyUplink(info, { starlinkAsn = STARLINK_ASN, primaryAsn = PRIMARY_ASN } = {}) {
  const org = info.org || "";
  const asn = info.asn || "";
  const onStarlink = (!!asn && asn === starlinkAsn) || STARLINK_RE.test(org);
  const onBackup = onStarlink || (!!primaryAsn && !!asn && asn !== primaryAsn);
  const label = !info.ok
    ? "unknown (uplink check failed)"
    : onStarlink
      ? `Starlink satellite${asn ? ` (${asn})` : ""} - likely throttled standby`
      : org || `${info.ip} (provider unknown)`;
  return { ...info, onStarlink, onBackup, label };
}

// One-shot status with a human summary (what Frank's tool returns).
export async function uplinkStatus(opts = {}) {
  const c = classifyUplink(await currentUplink(opts), opts);
  const summary = !c.ok
    ? "Could not determine the uplink (both public-IP checks failed). The internet may be fully down."
    : c.onStarlink
      ? `On the STARLINK backup${c.asn ? ` (${c.asn})` : ""}, public IP ${c.ip}. If it is still in standby (~300 kB/s), activate full Starlink service.`
      : `Uplink normal: ${c.label}, public IP ${c.ip}.`;
  return { ...c, summary };
}

// Lloyd-only watcher. Polls on a fast cadence and calls notify(msg) ONCE per
// transition (primary<->backup). notify is Lloyd's notifyOwner; Frank never calls
// this (no outbound channel). Returns a stop() function. State is not latched on a
// transient "down" so a brief check failure doesn't fake a recovery/failover.
export function startUplinkWatcher({
  notify,
  fetchImpl = fetch,
  intervalMs = Number(process.env.UPLINK_CHECK_INTERVAL_MS || 120000),
  log,
} = {}) {
  let last = null; // 'primary' | 'backup'
  const tick = async () => {
    const s = await uplinkStatus({ fetchImpl });
    if (!s.ok) return "down"; // can't tell; don't change state or alert
    const state = s.onBackup ? "backup" : "primary";
    if (last !== null && state !== last) {
      const msg =
        state === "backup"
          ? `Internet failed over to Starlink backup${s.asn ? ` (${s.asn})` : ""}. If still in standby (~300 kB/s), activate full Starlink service now.`
          : `Internet recovered to the primary uplink (${s.label}).`;
      await notify(msg);
      log?.info?.("uplink transition", { from: last, to: state });
    }
    last = state;
    return state;
  };
  const id = setInterval(() => tick().catch((e) => log?.error?.("uplink watcher tick failed", { reason: e?.message || String(e) })), intervalMs);
  if (id.unref) id.unref();
  tick().catch(() => {}); // prime immediately
  return () => clearInterval(id);
}
