// One-time grounding seed for the Sasshey COO (workstream S step 5 — the first
// real COO). Scoped to agent "sasshey-coo" so it never pollutes another brain.
// Idempotent: re-running detects the sentinel fact and skips. Run on the live host:
//   node --env-file=.env data/seed-coo-sasshey.mjs
import { remember, recall } from "../src/memory.js";

const AGENT = "sasshey-coo";
const FACTS = [
  "Sasshey is a SaaS wardrobe-inventory tool paired with a consignment marketplace; revenue is memberships plus brokering consignment/resale sales.",
  "Sasshey's goal: become the default way style-conscious sellers catalog their wardrobe and move pieces — turning idle closets into managed, monetized inventory.",
  "Sasshey runs on an $80/month budget. The COO is on Sonnet, company specialists on Haiku. At this early stage stay well under budget; most reviews should be a short status with no spend.",
  "Shared family specialists the Sasshey COO may request through Lloyd: finance (Patrick), dev (Steve), resale (Shey). The family already runs real resale via TheRealReal, so resale is the most actionable lever right now.",
  "Sasshey's own specialists: Inventory (catalog/data model), Marketing (acquisition/retention, drafts only), Buyer behavior analyst (demand/pricing signals), Sales (consignment pipeline). Marketing/analyst/sales can research the web; Inventory is internal-data.",
  "Sasshey is very early stage. Only emit a request when something concrete is genuinely warranted; never invent data you do not have. All outbound/spend goes through Lloyd's confirmation gate.",
];

const existing = await recall("Sasshey wardrobe-inventory consignment", 5, { agent: AGENT });
if (JSON.stringify(existing || "").includes("wardrobe-inventory")) {
  console.log(`${AGENT} already seeded — skipping.`);
  process.exit(0);
}
for (const f of FACTS) await remember(f, { agent: AGENT });
console.log(`seeded ${FACTS.length} grounding facts for ${AGENT}`);
