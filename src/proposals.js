// Change-proposal log for the dev specialist. Per its persona, dev must "propose
// changes as clear diffs or step-by-step plans the chief of staff can approve" and
// must NOT deploy or change anything autonomously. So its only write tool records a
// proposal here for a human to review and run. Local JSON, no side effects.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const PATH = () => process.env.PROPOSALS_PATH || "./data/proposals.json";

async function load() {
  try {
    return JSON.parse(await readFile(PATH(), "utf8"));
  } catch {
    return { items: [] };
  }
}
async function save(db) {
  await mkdir(dirname(PATH()), { recursive: true });
  await writeFile(PATH(), JSON.stringify(db, null, 2));
}

/** @param {{title:string, rationale?:string, steps?:string[]}} input */
export async function addProposal({ title, rationale = "", steps = [] } = {}) {
  if (!title || !String(title).trim()) throw new Error("title is required");
  const db = await load();
  const item = {
    id: randomUUID().slice(0, 8),
    title: String(title).trim(),
    rationale,
    steps: Array.isArray(steps) ? steps : [],
    status: "proposed",
    createdAt: new Date().toISOString(),
  };
  db.items.push(item);
  await save(db);
  return item;
}

export async function listProposals() {
  return (await load()).items;
}
