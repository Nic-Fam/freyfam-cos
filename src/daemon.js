import { startQueueConsumer, stopQueueConsumer } from "./queue.js";
import { startHeartbeat, tick } from "./heartbeat.js";

const once = process.argv.includes("--heartbeat-once");

async function main() {
  if (once) {
    console.log("[daemon] running a single heartbeat tick and exiting");
    await tick();
    process.exit(0);
  }

  console.log("[daemon] Frey Family Chief of Staff starting");
  const hb = startHeartbeat();

  process.on("SIGINT", () => shutdown(hb));
  process.on("SIGTERM", () => shutdown(hb));

  await startQueueConsumer(); // blocks until stopped
}

function shutdown(hb) {
  console.log("\n[daemon] shutting down");
  clearInterval(hb);
  stopQueueConsumer();
  setTimeout(() => process.exit(0), 500);
}

main().catch((err) => {
  console.error("[daemon] fatal:", err);
  process.exit(1);
});
