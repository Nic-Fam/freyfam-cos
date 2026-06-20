import { app } from "@azure/functions";
import { runSpecialist } from "../src/specialists/runner.js";

// ===========================================================================
// Azure Function entrypoint for ONE specialist. This is the remote half of the
// `delegate` seam (src/delegate.js): Lloyd POSTs {agent, task}, this runs the
// SAME transport-agnostic core (runner.js) that ran in-process, and returns
// {text}. Nothing else about a specialist changes when it moves here.
//
// Isolation is layered:
//   - auth: authLevel "function" -> caller must present the function key
//     (Lloyd sends it as x-functions-key; see delegate.invokeRemoteSpecialist)
//   - identity: this app runs under its OWN managed identity, scoped to its OWN
//     Table (set at provision time) - it cannot read another specialist's data
//   - agent pin: COS_AGENT names the one agent this app may serve; a task for
//     any other agent is refused here, so a misrouted call can't cross domains
//
// HARD CONSTRAINT preserved: a specialist only RETURNS text. It has no outbound
// channel and no confirmation power - those stay on Lloyd. Running here cannot
// grant a specialist anything it lacked in-process.
// ===========================================================================

const PINNED = process.env.COS_AGENT; // the single agent this deployment serves

app.http("specialist", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (request, context) => {
    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, jsonBody: { error: "body must be JSON {agent, task}" } };
    }

    const agent = body?.agent || PINNED;
    const task = body?.task;
    const images = Array.isArray(body?.images) ? body.images : undefined;

    if (!task || !String(task).trim()) {
      return { status: 400, jsonBody: { error: "task is required" } };
    }
    if (PINNED && agent !== PINNED) {
      // Defense-in-depth: this app is scoped to PINNED's identity + data, so it
      // must not run another agent's work even if asked.
      return { status: 403, jsonBody: { error: `this deployment serves "${PINNED}", not "${agent}"` } };
    }

    try {
      const text = await runSpecialist(agent, task, { images });
      return { jsonBody: { text } };
    } catch (err) {
      context.error(`specialist "${agent}" failed`, err);
      return { status: 500, jsonBody: { error: "specialist run failed" } };
    }
  },
});
