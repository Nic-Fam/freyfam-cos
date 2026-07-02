import { embed, cosine, isEnabled, MODEL_ID } from "./embeddings.js";
import { createCollection } from "./stores/collection.js";
import { isCompanyAgent } from "./companies.js";

// ===========================================================================
// The shared "brain" lives LOCALLY on the MacBook (no Azure AI Search needed
// since the chief of staff is local). JSON-backed store of {id, text, meta,
// embedding, embModel}.
//
// Recall is HYBRID (workstream E): a local sentence-transformer (embeddings.js)
// gives semantic similarity, blended with the TF-IDF lexical score below so
// exact-word hits ("oat milk") still rank. When embeddings are disabled or the
// model can't load, recall degrades cleanly to pure lexical. Items embedded by
// an older/no model (embModel mismatch) simply skip the semantic term until
// re-embedded (data/reembed.mjs).
//
// TODO (Claude Code): swap the JSON store for sqlite-vec or LanceDB once the
// corpus outgrows an in-memory scan. Keep the recall()/remember() interface.
// ===========================================================================

// Lloyd's brain on the pluggable collection store (workstream R — durable memory):
// local JSON (data/brain.json, identical format) by default, or his own
// managed-identity Azure Table when COS_TABLE_* is set, so recall/remember survive a
// local disk failure NATIVELY (not only via the periodic Blob snapshot). The
// recall/remember interface is unchanged; only where the bytes live moved.
const col = () => createCollection({ file: process.env.BRAIN_PATH || "./data/brain.json", partition: "brain" });

// Read the whole brain (recall scans it; corpus is small at household size).
async function load() {
  return { items: await col().list() };
}

// Compute the stored vector for a fact. Returns { embedding, embModel } where
// embedding is null when embeddings are disabled/unavailable (recall then leans
// on the lexical score below). Tagging the model lets recall ignore vectors
// produced by a different model rather than comparing incompatible spaces.
async function embedItem(text) {
  const embedding = await embed(text);
  return { embedding, embModel: embedding ? MODEL_ID : null };
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
  const { embedding, embModel } = await embedItem(text);
  await col().add({ id: Date.now() + ":" + Math.random().toString(36).slice(2), text, meta, embedding, embModel });
}

/**
 * Forget (delete) every memory item matching `pred(item)`. Returns the count
 * removed. Used to make a removal STICK: e.g. when a resale hunt is deleted, the
 * "Active archive hunt: ..." memory that would otherwise resurface it is forgotten
 * too. Runs against the same store recall reads, so it can't come back.
 */
export async function forget(pred) {
  const items = await col().list();
  const doomed = items.filter((it) => { try { return pred(it); } catch { return false; } });
  for (const it of doomed) await col().remove(it.id);
  return doomed.length;
}

/**
 * Save a fact only if no item with the exact same text already exists. Returns
 * true if it was written, false if skipped. Lets the seed script run repeatedly
 * without piling up duplicates. (recall/remember stay unchanged for callers.)
 */
export async function rememberOnce(text, meta = {}) {
  const items = await col().list();
  if (items.some((it) => it.text === text)) return false;
  const { embedding, embModel } = await embedItem(text);
  await col().add({ id: Date.now() + ":" + Math.random().toString(36).slice(2), text, meta, embedding, embModel });
  return true;
}

/**
 * Return the top-k most relevant memories for a query string.
 * Pass { agent } to scope recall to one specialist's memories plus unscoped
 * (shared) facts, so finance memories don't surface for resale and vice versa.
 * Omitting it (the chief of staff) searches everything.
 */
// Lexical TF-IDF cosine of `query` against each item in `pool` (aligned array).
// Pure, dependency-free; this is the always-available baseline.
function lexicalScores(pool, query) {
  const docs = pool.map((it) => termCounts(tokenize(it.text)));
  const N = docs.length;
  const df = new Map();
  for (const d of docs) for (const t of d.keys()) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((N + 1) / ((df.get(t) || 0) + 1)) + 1;

  const q = termCounts(tokenize(query));
  let qNorm = 0;
  for (const [t, c] of q) { const w = c * idf(t); qNorm += w * w; }
  qNorm = Math.sqrt(qNorm) || 1;

  return docs.map((d) => {
    let dot = 0, dNorm = 0;
    for (const [t, c] of d) {
      const w = c * idf(t);
      dNorm += w * w;
      if (q.has(t)) dot += w * (q.get(t) * idf(t));
    }
    dNorm = Math.sqrt(dNorm) || 1;
    return dot / (qNorm * dNorm);
  });
}

// Blend weight for the semantic term when an embedding is available for both
// query and item. Lexical keeps the rest so exact-token matches still count.
const SEMANTIC_WEIGHT = 0.6;

/**
 * Return the top-k most relevant memories for a query string.
 * Pass { agent } to scope recall. A FAMILY specialist sees its own memories plus
 * unscoped (shared household) facts, so finance memories don't surface for resale
 * yet shared family context still helps. A COMPANY-tier agent (a COO or company
 * specialist) is WALLED OFF from the household brain: it sees ONLY its own
 * memories, no unscoped bleed — a business agent should never surface personal/
 * household facts (matches the per-company isolation model). Omitting { agent }
 * (the chief of staff) searches everything.
 */
// Pure scoping rule (exported for tests). The chief (no agent) sees everything.
// A family specialist sees its own memories + unscoped household facts. A company
// agent (COO / company specialist) is walled off: its own memories only.
export function memoryPoolFor(items, agent) {
  if (!agent) return items;
  const walled = isCompanyAgent(agent);
  return items.filter((it) => it.meta?.agent === agent || (!it.meta?.agent && !walled));
}

export async function recall(query, k = 5, { agent } = {}) {
  const db = await load();
  const pool = memoryPoolFor(db.items, agent);
  if (pool.length === 0) return [];

  const lex = lexicalScores(pool, query);

  // Semantic term: embed the query once, cosine against items embedded by the
  // SAME model. null when embeddings are off/unavailable -> pure lexical.
  const qEmb = isEnabled() ? await embed(query) : null;

  const scored = pool.map((it, i) => {
    const sem =
      qEmb && it.embModel === MODEL_ID && Array.isArray(it.embedding)
        ? cosine(qEmb, it.embedding)
        : null;
    const score = sem == null ? lex[i] : SEMANTIC_WEIGHT * sem + (1 - SEMANTIC_WEIGHT) * lex[i];
    return { text: it.text, meta: it.meta, score, id: it.id };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
