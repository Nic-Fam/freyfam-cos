import { listFindings, resolveMatching } from "../security.js";
import { listSavedSearches } from "../saved-searches.js";
import { rememberFact, forgetMatching } from "../memory.js";
import { getAgentRules, addRule, removeRule } from "../rules.js";
import { logDecision } from "../decisions.js";

// ===========================================================================
// Zero-model specialist OPS. A deterministic store read does not need an LLM.
// Two scheduled jobs used to ask a specialist, in English, to "list your open
// findings" / "export your saved searches" — spinning a full agent loop (persona
// + tools + memory recall + a tool turn) on Sonnet/Haiku just to read a JSON
// file. The network scan ran that HOURLY, on Sonnet. These ops return the store
// data directly, no tokens.
//
// Isolation is preserved: an op runs on the SAME side as the specialist it names
// — in-process when delegate is local, or on the specialist's Mac/Function when
// remote (the server dispatches it). So the data still lives with, and is read
// under the identity of, the agent that owns it. An op has NO outbound channel
// and NO confirmation power, exactly like a specialist run.
//
// The delegate seam carries {agent, op, args} alongside the {agent, task} path;
// op callers read the returned {data}.
// ===========================================================================

export const SPECIALIST_OPS = {
  security: {
    /** Open (or any-status) findings, optionally filtered by a title prefix. */
    async list_findings({ status = "open", titlePrefix, since } = {}) {
      let items = await listFindings();
      if (status) items = items.filter((f) => f && f.status === status);
      if (titlePrefix) {
        const p = String(titlePrefix).toLowerCase();
        items = items.filter((f) => String(f?.title || "").toLowerCase().startsWith(p));
      }
      // `since` (ISO): only findings created or re-seen after it, so the digest
      // reports what is NEW instead of every open item every morning.
      if (since) items = items.filter((f) => String(f?.lastSeenAt || f?.createdAt || "") > String(since));
      return items;
    },
    /**
     * The family closed an issue. Resolve the matching findings HERE, where they
     * live, and record the closure in Frank's own decision log and memory, which is
     * where his persona looks before re-raising anything. (Before this, "it's fine"
     * only reached Lloyd's alert store, so Frank never learned it was closed.)
     */
    async resolve_findings({ ids, match, note = "", by = "family" } = {}) {
      const r = await resolveMatching({ ids, match, note, by });
      for (const f of r.closed) {
        const why = note ? ` Reason: ${note}` : "";
        try {
          await logDecision("security", { title: `Closed by ${by}: ${f.title}`, decision: "Closed. Do not re-raise unless genuinely new evidence appears (a new alert dated after this closure).", rationale: note || "The family accepted it; their word closes a finding.", context: `finding ${f.id}` });
          await rememberFact(`CLOSED by ${by} on ${new Date().toISOString().slice(0, 10)}: "${f.title}". Treat as resolved; do not re-raise without new evidence.${why}`, { agent: "security" });
        } catch { /* the closure itself already landed; bookkeeping is best-effort */ }
      }
      return r;
    },
  },
  resale: {
    /** Raw saved-search list (what export_saved_searches returned as JSON text). */
    async export_saved_searches() {
      return listSavedSearches();
    },
  },
};

// Ops every agent serves (2026-10-26): its OWN memory and standing rules, written
// on the machine where it runs. Before these existed, the chief's
// remember(agent=...) and add_rule(agent=...) wrote to LLOYD's disk while every
// specialist ran remote and read its own store, so specialist memories and rules
// silently went nowhere. Each op runs on the specialist's side of the seam, so the
// data still lives under that specialist's identity.
export const COMMON_OPS = {
  async remember(agent, { text, supersedes } = {}) {
    return rememberFact(text, { agent, supersedes });
  },
  async forget(agent, { match } = {}) {
    return forgetMatching(match, { agent });
  },
  async list_rules(agent) {
    return getAgentRules(agent);
  },
  async add_rule(agent, { text } = {}) {
    return addRule(text, { agent });
  },
  async remove_rule(agent, { match } = {}) {
    return { removed: await removeRule(match, { agent }) };
  },
};

function opFor(agent, op) {
  const own = Object.hasOwn(SPECIALIST_OPS, agent) && Object.hasOwn(SPECIALIST_OPS[agent], op) ? SPECIALIST_OPS[agent][op] : null;
  if (own) return (args) => own(args);
  if (Object.hasOwn(COMMON_OPS, op)) return (args) => COMMON_OPS[op](agent, args);
  return null;
}

export function hasSpecialistOp(agent, op) {
  return Boolean(opFor(agent, op));
}

/** Run a named zero-model op for an agent. Throws if the agent/op pair is unknown. */
export async function runSpecialistOp(agent, op, args = {}) {
  const fn = opFor(agent, op);
  if (!fn) throw new Error(`no op "${op}" for agent "${agent}"`);
  return fn(args || {});
}
