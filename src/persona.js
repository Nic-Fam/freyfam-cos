import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderCompanyPersona } from "./companies.js";

// Cached loader for the agents/*.md persona files. Shared by the chief
// (orchestrator.js) and the specialist runner (specialists/runner.js) so both
// resolve persona text the same way regardless of where they run.
//
// COO-tier agents (a COO or a company specialist) have NO standalone .md file;
// their persona is rendered from a shared template plus the company's roster
// entry (see companies.js / agents/*.template.md). We check that first so a
// data-driven company agent resolves without a per-agent file.

const __dir = dirname(fileURLToPath(import.meta.url));
const cache = new Map();

export async function persona(name) {
  if (cache.has(name)) return cache.get(name);
  const rendered = renderCompanyPersona(name);
  if (rendered != null) {
    cache.set(name, rendered);
    return rendered;
  }
  const text = await readFile(join(__dir, "agents", `${name}.md`), "utf8");
  cache.set(name, text);
  return text;
}
