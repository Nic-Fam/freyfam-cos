// ===========================================================================
// The COO request seam (TRACKER workstream S, step 2). A COO cannot act on the
// world: it has no outbound channel and no `delegate` (that is CHIEF_ONLY). What
// it CAN do is emit structured REQUESTS that Lloyd fulfills behind his gate. This
// keeps the confirmation gate (hard constraint #2) the single chokepoint for
// every real-world effect, no matter how many COOs exist.
//
// Mechanism (transport-safe): the three request tools push onto a per-invocation
// collector that runSpecialist returns alongside the COO's text ({text, requests}).
// The requests ride the return value back through the `delegate` seam - they are
// NOT written to a shared store Lloyd reaches into, so this works identically when
// a COO later runs remotely in Azure.
//
// Fulfillment (fulfillCooRequests, run by Lloyd):
//   - request_specialist -> validate against the company's allowedSpecialists,
//     then `delegate` to that specialist. Routine help; a specialist only
//     surfaces, so this is NOT gated.
//   - request_heavy_lift  -> a confirmation-gated ask to Nic to run a scoped task
//     himself in a human-driven Claude Code session (never an automated agent on
//     the subscription; see workstream Q reversal).
//   - request_action      -> a confirmation-gated outbound/spend; on approval it
//     is recorded as an approved action for a HUMAN to execute (constraint #3:
//     the agent surfaces, a person acts). No automated outbound.
// ===========================================================================

const obj = (properties, required = []) => ({ type: "object", properties, required });

export const REQUEST_TOOL_NAMES = ["request_specialist", "request_heavy_lift", "request_action"];

/** Tool definitions for the three COO request tools (added to the COO allowlist). */
export function requestToolDefs() {
  return [
    {
      name: "request_specialist",
      description:
        "Ask Lloyd to put a shared family specialist on a scoped task for your company (e.g. Steve for a dev push, Patrick for a finance read). Routine help. You can only request specialists your company is allowed to use. The specialist surfaces a result; it does not act on the world.",
      input_schema: obj(
        { specialist: { type: "string", description: "the family specialist key, e.g. dev, finance, resale" }, task: { type: "string", description: "the scoped task for them" } },
        ["specialist", "task"]
      ),
    },
    {
      name: "request_heavy_lift",
      description:
        "Ask Nic to personally run a serious or open-ended piece of work in his own Claude Code session (NOT an automated agent). Use this for large build/dev work beyond a quick specialist tweak. It goes to Nic as a confirmation-gated ask; he decides whether to take it on.",
      input_schema: obj(
        { brief: { type: "string", description: "a crisp brief of the work to be done" }, why: { type: "string", description: "why it matters / the expected payoff" } },
        ["brief"]
      ),
    },
    {
      name: "request_action",
      description:
        "Request an outbound action or a spend on the company's behalf (a marketing email, a tool signup, a purchase). You cannot do this yourself. It goes through Lloyd's confirmation gate; on approval it is recorded as an approved action for a human to carry out. Never assume it has happened.",
      input_schema: obj(
        { action: { type: "string", description: "the action to take" }, detail: { type: "string", description: "specifics: recipients, amounts, copy, links" } },
        ["action"]
      ),
    },
  ];
}

/**
 * Handlers for the request tools, bound to a per-invocation `requests` collector.
 * Each records a structured request and returns a short ack to the COO; the real
 * fulfillment happens later, on Lloyd's side, via fulfillCooRequests. When called
 * without a collector (e.g. a test just listing tools) they no-op into a throwaway
 * array, so the tools<->handlers 1:1 invariant always holds.
 */
export function requestHandlers(requests = []) {
  const push = (r) => requests.push(r);
  return {
    request_specialist: async ({ specialist, task } = {}) => {
      const s = String(specialist || "").trim().toLowerCase();
      push({ type: "specialist", specialist: s, task: String(task || "").trim() });
      return `Requested ${s || "(unnamed specialist)"} for: ${String(task || "").trim()}`;
    },
    request_heavy_lift: async ({ brief, why } = {}) => {
      push({ type: "heavy_lift", brief: String(brief || "").trim(), why: String(why || "").trim() });
      return `Requested a heavy lift (a human-driven session, gated to Nic) for: ${String(brief || "").trim()}`;
    },
    request_action: async ({ action, detail } = {}) => {
      push({ type: "action", action: String(action || "").trim(), detail: String(detail || "").trim() });
      return `Requested an action (goes through the confirmation gate): ${String(action || "").trim()}`;
    },
  };
}

/**
 * Lloyd fulfills a COO's emitted requests and returns a human-readable summary to
 * fold into the delegate tool result. Pure of transport: `delegate` and
 * `requestConfirmation` are injected (the real ones in the orchestrator, mocks in
 * tests). `coo` is the roster entry (carries company + allowedSpecialists).
 */
export async function fulfillCooRequests(coo, requests, { delegate, requestConfirmation } = {}) {
  if (!Array.isArray(requests) || !requests.length) return "";
  const allowed = new Set(coo.allowedSpecialists || []);
  const lines = [];

  for (const r of requests) {
    if (r?.type === "specialist") {
      if (!allowed.has(r.specialist)) {
        lines.push(`- "${r.specialist}" is not on ${coo.company}'s allowed specialists (${[...allowed].join(", ") || "none"}); skipped.`);
        continue;
      }
      const res = await delegate({ agent: r.specialist, task: r.task });
      const text = typeof res === "string" ? res : res?.text ?? "";
      lines.push(`- ${r.specialist}: ${text}`);
    } else if (r?.type === "heavy_lift") {
      const { instruction } = await requestConfirmation(
        `Heavy lift requested by the ${coo.company} COO (you would run this yourself in a Claude Code session):\n${r.brief}${r.why ? `\nWhy: ${r.why}` : ""}`,
        "heavy_lift",
        { coo: coo.key, company: coo.company, brief: r.brief, why: r.why }
      );
      lines.push(`- Heavy lift staged for your approval: ${r.brief}. ${instruction}`);
    } else if (r?.type === "action") {
      const { instruction } = await requestConfirmation(
        `Action requested by the ${coo.company} COO (outbound/spend; a human executes on approval):\n${r.action}${r.detail ? `\nDetail: ${r.detail}` : ""}`,
        "coo_action",
        { coo: coo.key, company: coo.company, action: r.action, detail: r.detail }
      );
      lines.push(`- Action staged for approval: ${r.action}. ${instruction}`);
    } else {
      lines.push(`- Unknown request type ${JSON.stringify(r?.type)}; skipped.`);
    }
  }
  return lines.length ? `Requests from the ${coo.company} COO:\n${lines.join("\n")}` : "";
}
