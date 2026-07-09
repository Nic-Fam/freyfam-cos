// Dead-man's-switch beacon for TOTAL internet outage. When the house loses ALL
// connectivity (fiber AND the Starlink backup), no local alert can escape — Slack,
// email, and iMessage all need the internet that's gone. So instead Lloyd PUSHES a
// periodic "still alive" ping to an off-site monitor. The monitor runs in the cloud,
// independent of the house, and alerts the owner when the pings STOP for longer than
// its grace window. The silence is the signal.
//
// Provider-agnostic: DEADMAN_PING_URL can point at any push-heartbeat monitor
// (Healthchecks.io, Cronitor, UptimeRobot, a self-hosted endpoint). Those have free
// tiers that cover a single check, so this adds no meaningful cost — the beacon is
// one tiny POST every few minutes. No-op if DEADMAN_PING_URL is unset.
//
// Best-effort and NEVER throws: a failed ping is EXPECTED when the link is down
// (that's the whole point), and must never disturb the daemon.

export async function pingOnce({ url, fetchImpl = fetch, statusFn, log, timeoutMs = 10000 } = {}) {
  if (!url) return false;
  let body = "alive";
  try {
    if (statusFn) body = String(await statusFn()).slice(0, 200) || "alive";
  } catch {
    // statusFn is optional colour; never let it block the liveness ping.
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { method: "POST", body, signal: ctrl.signal });
    return !!(res && res.ok);
  } catch (e) {
    log?.warn?.("dead-man beacon ping failed (link down?)", { reason: e?.message || String(e) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function startDeadManBeacon({
  url = process.env.DEADMAN_PING_URL,
  intervalMs = Number(process.env.DEADMAN_PING_INTERVAL_MS || 300000),
  fetchImpl = fetch,
  statusFn,
  log,
} = {}) {
  if (!url) {
    log?.info?.("dead-man beacon disabled (DEADMAN_PING_URL unset)");
    return () => {};
  }
  const beat = () => pingOnce({ url, fetchImpl, statusFn, log });
  const id = setInterval(beat, intervalMs);
  if (id.unref) id.unref();
  beat(); // prime immediately so the monitor sees us right after a restart
  log?.info?.("dead-man beacon started", { intervalMs });
  return () => clearInterval(id);
}
