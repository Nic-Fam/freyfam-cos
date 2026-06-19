import { startQueueConsumer, stopQueueConsumer } from "./queue.js";
import { startHeartbeat, tick } from "./heartbeat.js";
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

  process.on("SIGINT", () => shutdown(hb));
  process.on("SIGTERM", () => shutdown(hb));

  await startQueueConsumer(); // blocks until stopped
}

function shutdown(hb) {
  log.info("shutting down");
  clearInterval(hb);
  stopQueueConsumer();
  closeBrowser(); // release the headless browser if one was launched (no-op otherwise)
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  log.error("fatal", { reason: err.message, stack: err.stack });
  process.exit(1);
});
