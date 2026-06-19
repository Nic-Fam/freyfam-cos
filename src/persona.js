import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Cached loader for the agents/*.md persona files. Shared by the chief
// (orchestrator.js) and the specialist runner (specialists/runner.js) so both
// resolve persona text the same way regardless of where they run.

const __dir = dirname(fileURLToPath(import.meta.url));
const cache = new Map();

export async function persona(name) {
  if (cache.has(name)) return cache.get(name);
  const text = await readFile(join(__dir, "agents", `${name}.md`), "utf8");
  cache.set(name, text);
  return text;
}
