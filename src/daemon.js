import { startQueueConsumer, stopQueueConsumer } from "./queue.js";
import { startHeartbeat, tick } from "./heartbeat.js";
import { startSlack } from "./channels/slack.js";
import { registerEmailApprovals } from "./channels/graph.js";
import { closeBrowser } from "./channels/browser.js";
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

  process.on("SIGINT", () => shutdown(hb));
  process.on("SIGTERM", () => shutdown(hb));

  await startQueueConsumer(); // blocks until stopped
}

function shutdown(hb) {
  log.info("shutting down");
  clearInterval(hb);
  stopQueueConsumer();
  closeBrowser(); // release the headless browser if one was launched (no-op otherwise)
  // Give in-flight work 500ms to drain, then SIGKILL rather than exit(0).
  // onnxruntime-node (pulled in by the local embeddings brain) aborts in its
  // native static destructor at normal exit ("mutex lock failed") on Intel macOS,
  // turning a clean shutdown into SIGABRT/134 and spamming the error log. The
  // embedding work itself is unaffected; this just skips the buggy teardown.
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 500);
}

main().catch((err) => {
  log.error("fatal", { reason: err.message, stack: err.stack });
  process.exit(1);
});
