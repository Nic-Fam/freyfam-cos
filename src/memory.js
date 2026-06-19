import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// ===========================================================================
// The shared "brain" lives LOCALLY on the MacBook (no Azure AI Search needed
// since the chief of staff is local). This is a deliberately small, dependency-
// free starting point: a JSON-backed store of {id, text, embedding, meta}.
//
// TODO (Claude Code): swap the naive cosine search for sqlite-vec or LanceDB
// once the corpus grows, and replace embedHash() with a real embedding call.
// Keep the same recall()/remember() interface so callers don't change.
// ===========================================================================

const STORE_PATH = process.env.BRAIN_PATH || "./data/brain.json";

async function load() {
  try {
    return JSON.parse(await readFile(STORE_PATH, "utf8"));
  } catch {
    return { items: [] };
  }
}
async function save(db) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(db, null, 2));
}

// Placeholder embedding so the scaffold runs with zero extra services.
// Replace with a real embedding model for meaningful semantic recall.
function embedHash(text, dims = 64) {
  const v = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) v[i % dims] += text.charCodeAt(i);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export async function remember(text, meta = {}) {
  const db = await load();
  db.items.push({ id: Date.now() + ":" + Math.random().toString(36).slice(2), text, meta, embedding: embedHash(text) });
  await save(db);
}

/** Return the top-k most relevant memories for a query string. */
export async function recall(query, k = 5) {
  const db = await load();
  const q = embedHash(query);
  return db.items
    .map((it) => ({ ...it, score: cosine(q, it.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ text, meta, score }) => ({ text, meta, score }));
}
