import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// Inbound de-duplication. The Azure queue is at-least-once: if the daemon is
// reset (or a turn runs past the visibility timeout) AFTER a message is handled
// but BEFORE it is acked/deleted, the SAME message (stable messageId) reappears
// and gets processed again — re-staging a confirmation with a fresh code, or
// re-running a "YES" approval. We record each messageId here (PERSISTED, so it
// survives the restart that causes the redelivery) and skip ones we've seen.
//
// The queue consumer marks a message processed BEFORE handling it and unmarks it
// only if handling fails (so transient failures still retry). A reset mid-handle
// therefore drops that one message (the family re-asks) rather than duplicating
// it — the safer trade for actions that send email or money.
// ===========================================================================

const STORE_PATH = () => process.env.PROCESSED_MSGS_PATH || "./data/processed-messages.json";
const CAP = Number(process.env.PROCESSED_MSGS_CAP ?? 500); // bounded FIFO; redelivery windows are short

async function load() {
  try {
    const arr = JSON.parse(await readFile(STORE_PATH(), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
async function save(arr) {
  await mkdir(dirname(STORE_PATH()), { recursive: true });
  await writeFile(STORE_PATH(), JSON.stringify(arr, null, 2));
}

export async function isProcessed(id) {
  if (!id) return false;
  return (await load()).includes(String(id));
}

export async function markProcessed(id) {
  if (!id) return;
  const arr = await load();
  if (arr.includes(String(id))) return;
  arr.push(String(id));
  while (arr.length > CAP) arr.shift(); // drop oldest; old ids can no longer be redelivered
  await save(arr);
}

export async function unmarkProcessed(id) {
  if (!id) return;
  const arr = await load();
  const i = arr.indexOf(String(id));
  if (i >= 0) {
    arr.splice(i, 1);
    await save(arr);
  }
}
