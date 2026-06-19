// One-time migration: pull the OLD assistant's durable long-term memory into the
// local brain so cos doesn't start amnesiac. Reads (READ-ONLY) the assistant's
// `familyFacts` and `contacts` Azure Tables on the SAME storage account
// (AZURE_STORAGE_CONNECTION_STRING) and rememberOnce()s each as a brain note.
//
// Idempotent: re-running skips notes already present (by exact text). Writes ONLY
// to the local, gitignored brain.json - never to the tracked seed-notes.json, so
// no private family data lands in git. Run it on the machine the daemon runs on.
//
// Usage: node data/import-from-assistant.mjs

import "dotenv/config";
import { TableClient } from "@azure/data-tables";
import { rememberOnce } from "../src/memory.js";

const CONN = process.env.AZURE_STORAGE_CONNECTION_STRING;
if (!CONN) {
  console.error("AZURE_STORAGE_CONNECTION_STRING not set (check .env).");
  process.exit(1);
}
const table = (name) => TableClient.fromConnectionString(CONN, name);

async function importTable(name, toNote) {
  let total = 0, added = 0, skipped = 0;
  try {
    for await (const e of table(name).listEntities()) {
      total++;
      const note = toNote(e);
      if (!note || !note.text || !note.text.trim()) continue;
      (await rememberOnce(note.text.trim(), note.meta || {})) ? added++ : skipped++;
    }
  } catch (e) {
    console.error(`${name}: read failed (${e.statusCode || ""}) ${e.message}`);
    return 0;
  }
  console.log(`${name}: ${total} read -> ${added} added, ${skipped} already present`);
  return added;
}

// familyFacts -> the core long-term memory. Prefix person-specific facts with the
// person so recall keys on them; leave 'family'/blank facts as shared household notes.
const facts = await importTable("familyFacts", (e) => {
  const fact = (e.fact || "").trim();
  if (!fact) return null;
  const person = (e.person || "").trim();
  const text = person && person.toLowerCase() !== "family" ? `${person}: ${fact}` : fact;
  return { text, meta: { source: "assistant:familyFacts", category: e.category || "" } };
});

// contacts -> durable reference notes.
const contacts = await importTable("contacts", (e) => {
  const who = [e.name || e.displayName || e.rowKey, e.email, e.phone].filter(Boolean).join(", ");
  const notes = (e.notes || "").trim();
  if (!who && !notes) return null;
  return { text: `Contact: ${who}${notes ? `. ${notes}` : ""}`, meta: { source: "assistant:contacts" } };
});

console.log(`\nDone. ${facts + contacts} new note(s) imported into the local brain.`);
