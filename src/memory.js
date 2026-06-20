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
// --- Lexical recall (TF-IDF cosine over word tokens) -----------------------
// The stored embedHash() vector is a character-frequency hash: it does NOT
// capture meaning, so "Nic's work email" failed to surface the work-email fact.
// Until real embeddings land (deferred, see TRACKER step E), recall scores by
// TF-IDF over word tokens, which actually finds facts by their words. No new
// dependency or external provider — the embeddings deferral stands.
const STOPWORDS = new Set(
  "a an the of to in on for and or is are was were be been being it its this that these those i me my we our you your he she they them his her with at by from as do does did what whats when where how why who which".split(/\s+/)
);
// Crude, dependency-free stemmer so word forms match: "emails" -> "email",
// "addresses" -> "address", "appointments" -> "appointment". It need not be
// linguistically correct, only CONSISTENT across query + stored text (both run
// through it), so plural/singular mismatches stop scoring 0. ("business" etc.
// ending in -ss are left alone.)
function stem(t) {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y"; // categories -> category
  if (t.length > 4 && t.endsWith("es")) return t.slice(0, -2); // addresses -> address, boxes -> box
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1); // emails -> email
  return t;
}
function tokenize(s) {
  return (String(s).toLowerCase().match(/[a-z0-9]+/g) || [])
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
}
function termCounts(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

export async function remember(text, meta = {}) {
  const db = await load();
  db.items.push({ id: Date.now() + ":" + Math.random().toString(36).slice(2), text, meta, embedding: embedHash(text) });
  await save(db);
}

/**
 * Save a fact only if no item with the exact same text already exists. Returns
 * true if it was written, false if skipped. Lets the seed script run repeatedly
 * without piling up duplicates. (recall/remember stay unchanged for callers.)
 */
export async function rememberOnce(text, meta = {}) {
  const db = await load();
  if (db.items.some((it) => it.text === text)) return false;
  db.items.push({ id: Date.now() + ":" + Math.random().toString(36).slice(2), text, meta, embedding: embedHash(text) });
  await save(db);
  return true;
}

/**
 * Return the top-k most relevant memories for a query string.
 * Pass { agent } to scope recall to one specialist's memories plus unscoped
 * (shared) facts, so finance memories don't surface for resale and vice versa.
 * Omitting it (the chief of staff) searches everything.
 */
export async function recall(query, k = 5, { agent } = {}) {
  const db = await load();
  const pool = agent
    ? db.items.filter((it) => !it.meta?.agent || it.meta.agent === agent)
    : db.items;
  if (pool.length === 0) return [];

  // Document frequencies across the (small) pool for idf weighting.
  const docs = pool.map((it) => termCounts(tokenize(it.text)));
  const N = docs.length;
  const df = new Map();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const q = termCounts(tokenize(query));
  let qNorm = 0;
  for (const [t, c] of q) { const w = c * idf(t); qNorm += w * w; }
  qNorm = Math.sqrt(qNorm) || 1;

  return pool
    .map((it, i) => {
      const d = docs[i];
      let dot = 0, dNorm = 0;
      for (const [t, c] of d) {
        const w = c * idf(t);
        dNorm += w * w;
        if (q.has(t)) dot += w * (q.get(t) * idf(t));
      }
      dNorm = Math.sqrt(dNorm) || 1;
      return { text: it.text, meta: it.meta, score: dot / (qNorm * dNorm) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
