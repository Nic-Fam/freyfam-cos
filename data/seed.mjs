// Seed the local brain (memory.js) from data/seed-notes.json. Idempotent: a note
// already present (matched by exact text) is skipped, so re-running never piles
// up duplicates. Embeddings are still the deferred embedHash() - this just loads
// the family's existing notes into the hash store so recall has something real.
//
// Usage:
//   npm run seed                      # seed from data/seed-notes.json
//   node data/seed.mjs path/to.json   # seed from another notes file
//
// Honors BRAIN_PATH like the rest of the app, so it writes to the same store the
// daemon reads.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rememberOnce } from "../src/memory.js";

const here = dirname(fileURLToPath(import.meta.url));
const notesPath = process.argv[2] || join(here, "seed-notes.json");

const raw = JSON.parse(await readFile(notesPath, "utf8"));
const notes = Array.isArray(raw) ? raw : raw.notes;
if (!Array.isArray(notes)) {
  console.error(`No notes array found in ${notesPath} (expected an array or { notes: [...] }).`);
  process.exit(1);
}

let added = 0;
let skipped = 0;
for (const note of notes) {
  const text = typeof note === "string" ? note : note.text;
  const meta = typeof note === "string" ? {} : note.meta || {};
  if (!text || !String(text).trim()) continue;
  if (await rememberOnce(String(text).trim(), meta)) added++;
  else skipped++;
}

console.log(`Seeded brain from ${notesPath}: ${added} added, ${skipped} already present.`);
