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

// Relevance of each pool item to `query`: semantic + lexical blend, or lexical
// alone when embeddings are off. Shared by recall, dedup and supersede.
async function scorePool(pool, query) {
  const lex = lexicalScores(pool, query);
  // Semantic term: embed the query once, cosine against items embedded by the
  // SAME model. null when embeddings are off/unavailable -> pure lexical.
  const qEmb = isEnabled() ? await embed(query) : null;
  return pool.map((it, i) => {
    const sem =
      qEmb && it.embModel === MODEL_ID && Array.isArray(it.embedding)
        ? cosine(qEmb, it.embedding)
        : null;
    return sem == null ? lex[i] : SEMANTIC_WEIGHT * sem + (1 - SEMANTIC_WEIGHT) * lex[i];
  });
}

/** Save-time epoch ms from an item id ("1781878812436:xyz"), or null. */
function savedAt(it) {
  const ms = Number(String(it?.id || "").split(":")[0]);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A superseded fact (replaced by a newer one) is kept for history but never recalled. */
const isLive = (it) => !it?.meta?.supersededBy;

/**
 * Top-k memories for a query (2026-10-26 changes):
 *   - superseded facts are skipped, so "the tour moved to Thursday" is not
 *     returned next to the stale "the tour is Tuesday";
 *   - `minScore` drops irrelevant items. It defaults to 0 (return the top k no
 *     matter what) for tools and tests; the per-turn context injection passes
 *     RECALL_MIN_SCORE so "done 2" or "yes do that" no longer injects four
 *     unrelated facts;
 *   - among relevant items, newer ones get a small boost, so the current
 *     version of a fact outranks an older near-duplicate.
 */
export async function recall(query, k = 5, { agent, minScore = 0, now = Date.now() } = {}) {
  const db = await load();
  const pool = memoryPoolFor(db.items, agent).filter(isLive);
  if (pool.length === 0) return [];
  const rel = await scorePool(pool, query);
  const scored = pool.map((it, i) => {
    const at = savedAt(it);
    const ageDays = at ? Math.max(0, (now - at) / 864e5) : 365;
    const recency = rel[i] > 0 ? 0.05 * Math.exp(-ageDays / 90) : 0;
    return { text: it.text, meta: it.meta, score: rel[i] + recency, relevance: rel[i], id: it.id };
  });
  return scored
    .filter((s) => s.relevance >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Minimum relevance for a memory to be injected into a turn's context. */
export const RECALL_MIN_SCORE = Number(process.env.RECALL_MIN_SCORE ?? 0.12);

const normText = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const DUP_MIN = Number(process.env.MEMORY_DUP_MIN ?? 0.85);
const SUPERSEDE_MIN = Number(process.env.MEMORY_SUPERSEDE_MIN ?? 0.35);

/**
 * Save a fact the way a person keeps a notebook (2026-10-26):
 *   - an exact or near-exact duplicate of a live fact is skipped (no pile-up);
 *   - `supersedes` (a short description of the older fact this replaces, e.g.
 *     "Fairview tour is Tuesday") retires the closest live match in the same scope,
 *     so recall returns only the current version. The old fact is kept, marked
 *     supersededBy, for history.
 * Scope: `agent` set -> that agent's memories; unset -> shared household facts.
 * @returns {Promise<{saved:boolean, deduped?:boolean, id?:string, superseded:string[]}>}
 */
export async function rememberFact(text, { agent, supersedes, source } = {}) {
  const t = String(text || "").trim();
  if (!t) throw new Error("memory text is required");
  const c = col();
  const items = await c.list();
  const scope = items.filter((it) => isLive(it) && (agent ? it.meta?.agent === agent : !it.meta?.agent));
  if (scope.some((it) => normText(it.text) === normText(t))) return { saved: false, deduped: true, superseded: [] };
  if (scope.length) {
    const sims = lexicalScores(scope, t);
    if (Math.max(...sims) >= DUP_MIN) return { saved: false, deduped: true, superseded: [] };
  }
  const id = Date.now() + ":" + Math.random().toString(36).slice(2);
  const meta = { ...(agent ? { agent } : {}), ...(source ? { source } : {}) };
  const { embedding, embModel } = await embedItem(t);
  await c.add({ id, text: t, meta, embedding, embModel });

  const superseded = [];
  if (supersedes && scope.length) {
    const rel = await scorePool(scope, String(supersedes));
    let best = -1;
    rel.forEach((r, i) => { if (r >= SUPERSEDE_MIN && (best < 0 || r > rel[best])) best = i; });
    if (best >= 0) {
      const old = scope[best];
      await c.remove(old.id);
      await c.add({ ...old, meta: { ...(old.meta || {}), supersededBy: id, supersededAt: new Date().toISOString() } });
      superseded.push(old.text);
    }
  }
  return { saved: true, id, superseded };
}

/**
 * Forget live facts matching `match`: every fact whose text contains it
 * (case-insensitive), else the single best relevance match above SUPERSEDE_MIN.
 * Refuses to delete more than `max` at once (returns ambiguous) so a vague phrase
 * can't wipe the brain. Scope as rememberFact.
 * @returns {Promise<{removed:string[], ambiguous?:string[]}>}
 */
export async function forgetMatching(match, { agent, max = 3 } = {}) {
  const m = String(match || "").trim();
  if (m.length < 3) return { removed: [], ambiguous: [] };
  const c = col();
  const items = await c.list();
  // With an agent: only that agent's facts. Without one (the chief): anything on
  // this machine's brain, since the chief sees all of it in recall.
  const scope = items.filter((it) => isLive(it) && (agent ? it.meta?.agent === agent : true));
  let hits = scope.filter((it) => normText(it.text).includes(normText(m)));
  if (!hits.length && scope.length) {
    const rel = await scorePool(scope, m);
    let best = -1;
    rel.forEach((r, i) => { if (r >= SUPERSEDE_MIN && (best < 0 || r > rel[best])) best = i; });
    if (best >= 0) hits = [scope[best]];
  }
  if (hits.length > max) return { removed: [], ambiguous: hits.slice(0, 8).map((h) => h.text) };
  for (const h of hits) await c.remove(h.id);
  return { removed: hits.map((h) => h.text) };
}
