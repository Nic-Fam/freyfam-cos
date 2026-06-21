import { EMBEDDINGS } from "./config.js";
import { createLogger } from "./log.js";

// ===========================================================================
// Local semantic embeddings (workstream E). Runs a small sentence-transformer
// ON THE MAC via transformers.js — no API key, no per-call cost, and family
// memory text never leaves the machine (the local-first/privacy choice). The
// model (~90MB) downloads once to EMBEDDINGS.cacheDir, then runs offline.
//
// Everything degrades gracefully: if the provider is "none" or the model can't
// load, embed() returns null and memory.js falls back to its lexical (TF-IDF)
// recall, so the daemon never breaks for lack of a model.
// ===========================================================================

const log = createLogger("embeddings");

export const MODEL_ID = EMBEDDINGS.model;
export function isEnabled() {
  return EMBEDDINGS.provider === "local";
}

// Lazy singleton pipeline. We import transformers.js dynamically so the heavy
// dependency (and any model download) is only touched when embeddings are
// actually used — tests and `provider=none` never load it.
let _pipe = null;
let _failed = false;
async function pipeline() {
  if (_pipe || _failed) return _pipe;
  try {
    const tf = await import("@huggingface/transformers");
    tf.env.allowRemoteModels = true;
    if (EMBEDDINGS.cacheDir) tf.env.cacheDir = EMBEDDINGS.cacheDir;
    _pipe = await tf.pipeline("feature-extraction", MODEL_ID);
    log.info("embedding model loaded", { model: MODEL_ID });
  } catch (err) {
    _failed = true; // don't retry every call once we know it can't load
    log.error("embedding model unavailable; falling back to lexical recall", { reason: err.message });
  }
  return _pipe;
}

/**
 * Embed text into a unit-normalized vector (number[]), or null when embeddings
 * are disabled/unavailable. Mean-pooled + normalized, so cosine == dot product.
 */
export async function embed(text) {
  if (!isEnabled()) return null;
  const pipe = await pipeline();
  if (!pipe) return null;
  const out = await pipe(String(text ?? ""), { pooling: "mean", normalize: true });
  return Array.from(out.data);
}

/** Cosine similarity for two equal-length unit vectors (== dot product). Pure. */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
