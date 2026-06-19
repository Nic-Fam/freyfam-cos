# CLAUDE.md - Frey Family Chief of Staff

Context for Claude Code. Read this first. This is a persistent, local-first
household agent (OpenClaw-style) that runs as a daemon on Nic's MacBook. It is the
"after Claw" evolution of the earlier Azure-Functions Frey Family Assistant: the
brain and orchestration now live locally; Azure is just a durable front door.

## What this is

A single always-on Node daemon on the MacBook acting as the family **chief of
staff**. It pulls inbound messages from an Azure queue, triages them cheaply, routes
to the right specialist at the right model tier, and replies. A heartbeat makes it
proactive. Specialists (finance, dev, resale) are in-process personas the chief
delegates to, not separate deployments.

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
     |-- orchestrator.js ... chief of staff: triage -> tier -> agent loop -> reply
     |     |-- triage.js ... Haiku classifier (THE cost lever)
     |     |-- claude.js ... Anthropic wrapper: tiered models + prompt caching + tool loop
     |     |-- memory.js ... local vector brain (JSON now; swap to sqlite-vec later)
     |     |-- confirm.js .. human-in-the-loop approval over SMS
     |     |-- guards.js ... blocks outbound to read-only work domains
     |     |-- agents/*.md . persona files (chief-of-staff, finance, dev, resale)
     |     `-- channels/ ... twilio.js (SMS out), graph.js (email read/send)
   browser automation (Playwright) -> runs LOCALLY on the Mac (TODO, see plan)
  ===================================================
```

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
