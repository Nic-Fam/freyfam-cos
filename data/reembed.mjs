// Re-embed the local brain with the current embedding model (workstream E).
// Run after enabling/changing EMBEDDINGS_MODEL so existing facts (originally
// stored with the old char-hash placeholder, or no vector) gain real semantic
// vectors. Idempotent: items already on the current model are skipped.
//
//   npm run reembed
//
// Honors BRAIN_PATH and the EMBEDDINGS_* env (same as the daemon).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { embed, isEnabled, MODEL_ID } from "../src/embeddings.js";

const STORE_PATH = process.env.BRAIN_PATH || "./data/brain.json";

if (!isEnabled()) {
  console.error("Embeddings are disabled (EMBEDDINGS_PROVIDER != local). Nothing to do.");
  process.exit(0);
}

const db = JSON.parse(await readFile(STORE_PATH, "utf8").catch(() => '{"items":[]}'));
let updated = 0;
for (const it of db.items) {
  if (it.embModel === MODEL_ID && Array.isArray(it.embedding)) continue; // already current
  it.embedding = await embed(it.text);
  it.embModel = it.embedding ? MODEL_ID : null;
  if (it.embedding) updated++;
}
await mkdir(dirname(STORE_PATH), { recursive: true });
await writeFile(STORE_PATH, JSON.stringify(db, null, 2));
console.log(`Re-embedded ${updated} of ${db.items.length} items with ${MODEL_ID}.`);
