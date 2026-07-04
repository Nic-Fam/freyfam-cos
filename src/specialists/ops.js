import { listFindings } from "../security.js";
import { listSavedSearches } from "../saved-searches.js";

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
    async list_findings({ status = "open", titlePrefix } = {}) {
      let items = await listFindings();
      if (status) items = items.filter((f) => f && f.status === status);
      if (titlePrefix) {
        const p = String(titlePrefix).toLowerCase();
        items = items.filter((f) => String(f?.title || "").toLowerCase().startsWith(p));
      }
      return items;
    },
  },
  resale: {
    /** Raw saved-search list (what export_saved_searches returned as JSON text). */
    async export_saved_searches() {
      return listSavedSearches();
    },
  },
};

export function hasSpecialistOp(agent, op) {
  return Boolean(SPECIALIST_OPS[agent]?.[op]);
}

/** Run a named zero-model op for an agent. Throws if the agent/op pair is unknown. */
export async function runSpecialistOp(agent, op, args = {}) {
  const fn = SPECIALIST_OPS[agent]?.[op];
  if (!fn) throw new Error(`no op "${op}" for agent "${agent}"`);
  return fn(args || {});
}
