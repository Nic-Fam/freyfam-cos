# CLAUDE.md - Frey Family Chief of Staff

Context for Claude Code. Read this first. This is a persistent, local-first
household agent (OpenClaw-style) that runs as a daemon on Nic's MacBook. It is the
"after Claw" evolution of the earlier Azure-Functions Frey Family Assistant: the
chief-of-staff brain and orchestration live locally; Azure is the durable front
door and (target topology) the isolated home for the specialist agents. See the
"Topology" note below and TRACKER.md for the confirmed deployment plan.

## What this is

An always-on Node daemon on the MacBook acting as the family **chief of staff**
(Lloyd). It pulls inbound messages from an Azure queue, triages them cheaply, routes
to the right specialist at the right model tier, and replies. A heartbeat makes it
proactive. The five specialists are **finance (Patrick), dev (Steve), resale
(Shey), chef (Carmine), and security (Frank)**.

**Today** the specialists run in-process (one process), but the transport seam is
already built: `delegate` (`src/delegate.js`) routes each specialist either
in-process (`COS_SPECIALIST_MODE=local`, the default) or to that specialist's own
Azure Function (`mode=remote`), behind a config flag. The execution core
(`src/specialists/runner.js`) is transport-agnostic and is exactly the unit that
deploys to Azure. **Target (CONFIRMED, see Topology below):** Lloyd stays local
while the specialists run as isolated, serverless, scale-to-zero deployments in the
Azure tenant. The `delegate` seam's `{agent, task} -> text` signature stays stable,
so cutting over is flipping the flag once the Functions are stood up, not a rewrite.

## Architecture

```
  Twilio SMS / email
        |
        v
  Azure Function (public webhook)   <- already exists; trim to enqueue-and-ack
        |
        v
  Azure Storage Queue  "inbound-messages"
        |  (MacBook PULLS; never publicly reachable; survives reboots)
        v
  ============ MacBook daemon (this repo) ============
   daemon.js
     |-- queue.js .......... pulls messages, acks on success
     |-- heartbeat.js ...... timer -> cheap signals -> Haiku triage -> escalate on hits
     |     `-- cost.js ..... hourly: month-to-date spend (Anthropic Admin API + Azure
     |                       Cost Mgmt, zero model tokens) -> SMS owner at $100/cycle
     |-- orchestrator.js ... chief of staff: triage -> tier -> agent loop -> reply
     |     |-- triage.js ... Haiku classifier (THE cost lever)
     |     |-- claude.js ... Anthropic wrapper: tiered models + prompt caching + tool loop
     |     |-- memory.js ... local vector brain (JSON now; swap to sqlite-vec later)
     |     |-- confirm.js .. human-in-the-loop approval over SMS
     |     |-- guards.js ... blocks outbound to read-only work domains
     |     |-- agents/*.md . persona files (chief-of-staff, finance, dev, resale, chef, security)
     |     `-- channels/ ... twilio.js (SMS out), graph.js (email read/send)
   browser automation (Playwright) -> runs LOCALLY on the Mac (TODO, see plan)
  ===================================================
```

## Topology: current vs target (CONFIRMED 2026-06-19)

The diagram above is the **current** dev shape: one process, specialists in-process.
The **confirmed target** is a hybrid that keeps the trust-critical pieces local and
isolates the specialists:

- **Lloyd (chief of staff) runs locally** on a dedicated always-on Mac. He keeps the
  front door, inbound triage, the confirmation gate, ALL outbound channels
  (Twilio/Graph), the `guards.js` read-only-domain check, and memory recall.
- **The five specialists run in the Azure tenant** on serverless, scale-to-zero
  compute (Functions Consumption or Container Apps, min-replica-0). **No always-on
  per-agent computing.** Isolation comes from a **separate managed identity + Table
  Storage scope per specialist**, not from warm compute, so one specialist cannot
  read another's data or reach Lloyd's outbound channels.
- **Outbound + confirmation always stay on Lloyd.** Specialists surface actions; the
  local confirmation gate and guard enforce the hard constraints regardless of where
  compute runs. This preserves the read-only-domain guarantee after the split.
- Cost: ~$55-70/mo all-in (+$5-10 over the in-process design); Anthropic tokens, the
  dominant line, are unchanged. Full breakdown and the migration checklist in TRACKER.md.

Build specialist logic **transport-agnostic** (pure functions + a store) so the move
to Azure is a flag flip on `delegate`, not a rewrite.

**Memory location (RESOLVED 2026-06-19):** each remote specialist owns its **own
Table-scoped store** under its **own managed identity** — recall/remember and the
decision log included. This matches the isolation model (separate identity + scope
per agent, so one specialist cannot read another's memory) rather than a shared
brain or a callback to Lloyd. Lloyd keeps his own local brain. The `recall`/`remember`
and `logDecision`/`listDecisions` interfaces stay stable, so this is a store swap
inside the specialist runner, not a caller change.

## HARD CONSTRAINTS (do not regress these)

1. **Read-only work domains.** `flyerdefense.com` and `disney.com` are inbound-only.
   The assistant may read that mail but must NEVER send to it. Enforced in
   `guards.js` via `assertOutboundAllowed()`, called inside every outbound path.
   Any new outbound channel MUST call the guard.
2. **Human-in-the-loop for high stakes.** Spending money, sending messages on the
   family's behalf, and anything irreversible require approval via `confirm.js`.
   The triage step sets `high_stakes`; never auto-approve.
3. **No money movement.** Finance agent surfaces actions; humans execute them.

## Model routing = the cost strategy

Tiers in `config.js`: triage=Haiku, standard=Sonnet, heavy=Opus. The principle is
**route down by default, escalate only when the work earns it.** Two triage gates do
the saving:

- **Inbound triage** (`triage.js > triageInbound`): one Haiku call classifies each
  message (agent + complexity + high_stakes). `trivial` is answered on Haiku,
  `standard` on Sonnet, `complex`/high-stakes on Opus.
- **Heartbeat triage** (`triage.js > triageHeartbeat`): signals are gathered with
  plain API reads (zero model tokens); one Haiku call decides if anything is
  actionable. Only hits spend Sonnet/Opus tokens.

Prompt caching is on in `claude.js`: the persona/tools prefix is cached, so each turn
only pays full price for new content. Cache reads are ~10% of input.

Rough monthly math (15-min heartbeat, low household volume):

| Item | Naive | Triaged |
|------|-------|---------|
| Heartbeat (2,880 ticks/mo) | ~$43 (Sonnet each) | ~$6 (Haiku gate) + ~$7 escalations |
| Inbound (~15/day) | ~$35 (default-up) | ~$18 (tiered) |
| Heavy episodic tasks | ~$12 | ~$12 |
| **API total** | **~$90** | **~$40** |

Other monthly: Twilio ~$10, Azure Function+Storage ~$0-3 (free grants), MacBook
power ~$3-5, local brain + local Playwright $0. **All-in ~$50-60/mo typical.**

Cheap extra levers if you want it lower: raise `HEARTBEAT_INTERVAL_MS` to 30 min,
keep global routing (skip the 1.1x US-only multiplier), and use the Batch API for
non-urgent digests.

## Build plan (suggested order)

- [ ] **0. Boot.** `npm install`, copy `.env.example` -> `.env`, fill creds.
      `npm run once` to fire a single heartbeat tick end-to-end.
- [ ] **1. Front door.** Trim the existing Azure SMS Function to base64-enqueue
      `{from, body, channel, replyTo}` onto `inbound-messages` and ack Twilio. Do the
      same for the email handler.
- [ ] **2. Live loop.** `npm start`; text the Twilio number; confirm queue -> reply.
- [ ] **3. Graph wiring.** Verify app-only token + mailbox read in `graph.js`
      (this was the outstanding token debug from the old build). Confirm
      `recentMailSignals()` returns real headers.
- [ ] **4. Confirmation correlation.** Confirm `YES <code>` round-trips: the reply
      arrives via the queue -> `tryResolveConfirmation` resolves the pending action.
- [ ] **5. Real memory.** Replace `embedHash` with a real embedding call and the JSON
      store with sqlite-vec or LanceDB. Keep the `recall()/remember()` interface.
      Seed it from the family's existing notes.
- [ ] **6. Specialist tools.** Give finance/dev/resale their own scoped tools in
      `runSpecialist` (e.g. resale: saved-search fetchers for Poshmark/eBay/Vestiaire/
      RealReal/1stDibs).
- [ ] **7. Browser, unblocked.** Add local headless Playwright (the capability
      deferred on the Chromebook). Wire ordering behind the confirmation gate.
- [ ] **8. Harden.** Dead-letter after N dequeues (`m.dequeueCount`), structured
      logging, and a `pmset`/`caffeinate` setup so it runs lid-closed on power.
- [ ] **9. launchd.** Install `deploy/com.freyfam.cos.plist` for auto-restart.

## Run

```bash
npm install
cp .env.example .env   # then fill it in
npm run once           # single heartbeat tick (smoke test)
npm start              # full daemon: queue consumer + heartbeat
```

## Conventions

- ESM, Node 22.
- User-facing copy: warm, direct, brief, and **no em dashes** (family preference).
- Every outbound path calls `assertOutboundAllowed` before sending.
- Add tools as `{name, description, input_schema}` + a handler; the chief's tool list
  lives in `orchestrator.js`.
