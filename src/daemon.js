import { startQueueConsumer, stopQueueConsumer } from "./queue.js";
import { startHeartbeat, tick } from "./heartbeat.js";
import { startSlack } from "./channels/slack.js";
import { startImessage, stopImessage } from "./channels/imessage-inbound.js";
import { registerEmailApprovals } from "./channels/graph.js";
import { startVoiceServer, stopVoiceServer } from "./voice-server.js";
import { closeBrowser } from "./channels/browser.js";
import { startUplinkWatcher } from "./uplink.js";
import { startDeadManBeacon } from "./deadman.js";
import { notifyOwner } from "./channels/notify.js";
import { createLogger } from "./log.js";

const log = createLogger("daemon");
const once = process.argv.includes("--heartbeat-once");

async function main() {
  if (once) {
    log.info("running a single heartbeat tick and exiting");
    await tick();
    process.exit(0);
  }

  log.info("Frey Family Chief of Staff starting");
  const hb = startHeartbeat();
  // Email approval channel: each staged action emails Approve/Deny buttons.
  registerEmailApprovals();
  // Slack desk channel: no-op unless tokens are set. Non-fatal if it can't start.
  await startSlack().catch((e) => log.error("slack start failed", { reason: e.message }));
  // iMessage (BlueBubbles) inbound listener: no-op unless IMESSAGE_* is set.
  const imsg = startImessage();
  // Voice tile server: no-op unless COS_VOICE_SERVER=true + VOICE_TOKEN set.
  const voice = startVoiceServer();
  // Starlink failover watcher: low-data public-IP/ASN poll that alerts the owner on
  // a fiber<->Starlink transition so full Starlink service can be activated off the
  // throttled standby. Detection is Frank's domain (shared uplink.js); the outbound
  // notify stays here on Lloyd. Disable with UPLINK_MONITOR=false.
  const stopUplink = process.env.UPLINK_MONITOR === "false" ? null : startUplinkWatcher({ notify: notifyOwner, log });
  // Dead-man's switch for TOTAL outage: push a liveness beacon to an off-site
  // monitor (DEADMAN_PING_URL) that alerts the owner from the cloud if the pings
  // stop. No-op unless DEADMAN_PING_URL is set. Handles the case the uplink watcher
  // cannot: when NO local channel can reach out because the link is fully down.
  const stopBeacon = startDeadManBeacon({ log });

  process.on("SIGINT", () => shutdown(hb, imsg, voice, stopUplink, stopBeacon));
  process.on("SIGTERM", () => shutdown(hb, imsg, voice, stopUplink, stopBeacon));

  await startQueueConsumer(); // blocks until stopped
}

function shutdown(hb, imsg, voice, stopUplink, stopBeacon) {
  log.info("shutting down");
  clearInterval(hb);
  stopUplink?.(); // stop the Starlink failover watcher (no-op if it wasn't started)
  stopBeacon?.(); // stop the dead-man's-switch beacon (no-op if it wasn't started)
  stopQueueConsumer();
  stopImessage(imsg); // close the iMessage listener if it was started (no-op otherwise)
  stopVoiceServer(voice); // close the voice tile server (no-op if it wasn't started)
  closeBrowser(); // release the headless browser if one was launched (no-op otherwise)
  // Give in-flight work 500ms to drain, then SIGKILL rather than exit(0).
  // onnxruntime-node (pulled in by the local embeddings brain) aborts in its
  // native static destructor at normal exit ("mutex lock failed") on Intel macOS,
  // turning a clean shutdown into SIGABRT/134 and spamming the error log. The
  // embedding work itself is unaffected; this just skips the buggy teardown.
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
}

// --preflight: the deploy health gate. Reaching this line means every import
// above resolved and evaluated -- deps present, no missing/broken imports, config
// loaded -- which a bare `node --check` (syntax only) does NOT verify. Exit
// cleanly WITHOUT starting the daemon (no queue consumer, servers, or timers) so
// restart-from-main.sh can gate a deploy on real load-ability and roll back a
// depless/broken checkout instead of kickstarting it into a crash loop.
if (process.argv.includes("--preflight")) {
  log.info("preflight ok: import graph + config resolved");
  process.exit(0);
}

main().catch((err) => {
  log.error("fatal", { reason: err.message, stack: err.stack });
  process.exit(1);
});
