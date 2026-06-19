# TRACKER.md - Frey Family Chief of Staff

Development tracker for getting the daemon from "scaffold that compiles" to
"agents that actually work" (the Genet-grade bar). Read **CLAUDE.md** first for
architecture and hard constraints; this file tracks *state* and *who-can-do-what-
in-parallel*.

Last synced to code: 2026-06-18 (commit `884573d`, initial scaffold).

## Status legend

- `[ ]` not started
- `[~]` scaffolded but unverified (code exists, never run against real creds/data)
- `[x]` done and verified
- `[!]` known bug / blocker

## Where we actually are

The initial scaffold is more complete than a typical day-0: every file in the
architecture diagram exists and the happy-path code is written. What's missing is
**verification against real services**, the **stubbed brains** (memory embeddings,
specialist tools, browser), and a few **real bugs** in the proactive path.

`_smoke.mjs` covers guards + confirm parser + memory round-trip with zero network.
Run it anytime with `node _smoke.mjs` (no creds needed).

---

## Workstreams

Each workstream lists the files it owns so parallel sessions don't collide. The
**serial bottleneck is `orchestrator.js`** (tool list + handlers) - try to keep
only one session editing it at a time, or merge changes through small, additive
tool entries.

### A. Boot & verify the loop  `[~]`  — DO FIRST, blocks B/C/D verification

Owns: `.env`, local run only. No code changes expected.

Last verified: 2026-06-19 (this session).

- [x] `npm install` — clean, 0 vulnerabilities, 34 pkgs
- [x] `.env` present and filled: all keys populated (Anthropic, Twilio, Azure
      Storage, Graph). Models valid: triage=`claude-haiku-4-5`,
      standard=`claude-sonnet-4-6`, heavy=`claude-opus-4-8`. Only optional
      `TWILIO_MESSAGING_SERVICE_SID` is unset (`TWILIO_FROM` is set, so fine).
- [x] `node _smoke.mjs` passes (guards, confirm, memory) — no creds needed
- [x] `npm run once` fires a single heartbeat tick end-to-end. Verified live:
      Graph `recentMailSignals` returned 15 real signals (~0.66s, app-only token
      works → also de-risks workstream C); Haiku heartbeat triage returned
      `actionable=false` (~0.84s). Idle tick costs a fraction of a cent as designed.
- [x] `npm start` boots and connects: `[queue] consuming "inbound-messages"` (Azure
      Storage connection string works, `createIfNotExists` OK) + heartbeat scheduled.
- [x] **Queue → reply round-trip verified via EMAIL** (Twilio number not cleared yet,
      so SMS leg is blocked externally — A2P/number verification pending). Enqueued a
      synthetic `{channel:"email", from:"nic@freyfam.com"}` message directly onto
      `inbound-messages` (standing in for the not-yet-cutover Azure Function front
      door, workstream B). Daemon pulled it, triaged on Haiku, ran chief-of-staff on
      Sonnet, and replied via Graph `sendMail` ("Re: your note" → Nic@Freyfam.com).
      Queue drained to 0 (consume + ack works). This exercises the full daemon-side
      loop; only the Twilio transport is unverified.
- [x] **Live SMS round-trip verified (2026-06-19):** Twilio leg now clear. A real SMS
      through the deployed Azure Function front door (workstream B cutover) landed in
      `inbound-messages`, and the daemon pulled → triaged → replied. Full external
      path (Twilio → Function → queue → daemon → reply) confirmed end-to-end.
- [x] **`cos@freyfam.com` provisioned and live (2026-06-19).** Set as the mailbox's
      **primary address / UPN** (`assistant@` is the alias). Live `.env` flipped to
      `GRAPH_MAILBOX=cos@freyfam.com`; `config.js` default matches. Verified: Graph
      `recentMailSignals` resolves the new UPN and returned 5 messages. (Graph
      addresses the mailbox by UPN, not by proxy alias, so primary-vs-alias mattered.)
- Parallel-safe: yes once creds exist; this is the gate that lets other streams
  *verify* their work rather than just write it.

### B. Front door (Azure Function)  `[x]`  — EXTERNAL REPO `~/freyfam-assistant`

Owns: the existing Azure Functions project (NOT in this repo). Branch
`cos-front-door`.

- [x] Trim the SMS webhook to base64-enqueue `{from, body, channel, replyTo}` onto
      `inbound-messages` and ack Twilio immediately — `src/cos-queue.js` +
      gate in `src/functions/sms-handler.js` (runs after the unknown-sender drop,
      so toll-free policy stays enforced at the edge)
- [x] Same for the email handler — gate in `src/functions/email-handler.js`,
      after fetch+mark-read (dedup); folds subject into body
- [x] Feature-flagged `COS_ENQUEUE` (default OFF); flip the app setting to cut
      over, flip back to roll back. No code change to switch.
- [x] Wire contract pinned by `test/cos-queue.test.js` (encode → daemon decode
      round-trip + flag gate); 143/143 pass
- [x] **Cut over (2026-06-19):** PR #1 merged to `main` → CI deployed (deployment
      `cacaad52`, active); `COS_ENQUEUE=true` set on the Function App. Front door
      and daemon share the same storage account (`freyfamassistant8a4f`) + queue
      (`inbound-messages`), so the handoff is wired by construction. Verified live:
      a front-door-format message enqueued → launchd daemon consumed → triaged →
      replied via Graph `sendMail` → acked (queue drained to 0, no stderr errors).
      Roll back any time by flipping `COS_ENQUEUE` back to OFF (no code change).
- [ ] **SMS leg NOT yet confirmed (external block):** the cut-over verification ran
      over the EMAIL/enqueue path, not SMS. The Twilio number still isn't cleared, so
      SMS enqueues but replies fail at the Twilio send (same as the legacy path — no
      regression). Re-verify the live SMS round-trip once the number clears.
- [ ] **Media gap (deferred → tracked as workstream I):** the gate enqueues text
      only. MMS images, vCards, and forwarded-voicemail audio are dropped when
      COS_ENQUEUE is on (no media field in the payload). The front-door half of the
      MMS work lives here; see **workstream I (Multimodal / MMS intake)** for the
      full cross-repo plan and rationale.
- Parallel-safe: fully independent — different repo, different session, no overlap
  with this codebase. Only the queue *message shape* is the contract (see
  `queue.js:9-11`). Pin that shape and this can proceed in total isolation.

### C. Graph / mailbox token debug  `[~]`  — was the old build's open item

Owns: `src/channels/graph.js`, `src/config.js` (GRAPH block only).

- [x] Verify app-only client-credentials token actually acquires the
      `.default` scope against the tenant — confirmed 2026-06-19 (token acquired,
      live Graph calls succeed).
- [x] Confirm `recentMailSignals()` returns real headers from the assistant mailbox
      — confirmed 2026-06-19: returned 15 real signals (~0.66s).
- [x] Confirm app registration has `Mail.Read` + `Mail.Send` *application* perms
      with admin consent (sendMail path) — confirmed 2026-06-19: read works
      (`recentMailSignals`), and `sendMail` actually delivered ("Re: your note" →
      Nic@Freyfam.com) during the workstream-A email round-trip test, so Mail.Send
      consent is in place.
- Parallel-safe: yes — isolated file. Needs real Graph creds (overlaps A on creds).
- NOTE: C is effectively complete as a side effect of the A verification. Promote the
  `[~]` heading to `[x]` once someone gives it a dedicated read.

### D. Fix the proactive path bugs  `[!]`  — small, high value

Owns: `src/heartbeat.js`, and a few lines of `src/orchestrator.js`.

- [!] **Heartbeat results never reach the owner.** `heartbeat.js:38-43` escalates a
      non-fyi item via `handleInbound({channel:"sms", from:"heartbeat", replyTo:undefined})`.
      The orchestrator then does `sendSms(msg.replyTo || msg.from, text)` →
      `sendSms("heartbeat", text)`, which throws (not a phone number). The comment
      says "results go to owner via notifyOwner below" but there is no such call.
      Fix: give the orchestrator a way to return text without sending (e.g. an
      internal channel), and have the heartbeat `notifyOwner(result)` itself.
- [ ] Heartbeat re-runs full inbound triage on its synthetic "Proactive task…"
      string, double-paying the triage call. Minor cost leak; consider a direct
      agent run instead of round-tripping through `handleInbound`.
- Parallel-safe: touches `orchestrator.js` (the bottleneck) lightly — coordinate
  with F. Best done by the same session as F, or first and fast.

### E. Real memory  `[~]`  → `[ ]`

Owns: `src/memory.js`, new `data/` seed scripts. Interface (`recall`/`remember`)
must stay stable so callers don't change.

- DECISION (2026-06-18): **embeddings deferred** — keep `embedHash()` for now,
  revisit when the corpus grows. So the items below are *not* near-term.
- [ ] (deferred) Replace `embedHash()` (`memory.js:30`) with a real embedding call
- [ ] (deferred) Swap JSON store for sqlite-vec or LanceDB (keep signatures)
- [ ] Seed from the family's existing notes — still worth doing on the hash store
- [ ] Adopt Genet's **`decision.md` per-agent decision log** (see Genet bar below):
      a durable, human-readable record of *final decisions* each specialist made,
      separate from the vector recall. Cheap, high-value, no embeddings needed.
- Parallel-safe: **yes, fully isolated** — only `memory.js` + new files. Great
  candidate for its own session. `_smoke.mjs:16-20` already pins the contract.

### F. Specialist tools  `[~]`  → `[ ]`

Owns: `src/orchestrator.js` (`runSpecialist`, `tools`), `src/agents/*.md`, new tool
modules under `src/channels/` or a new `src/tools/`.

- [~] `runSpecialist` currently passes `tools: []` (`orchestrator.js:68`) — specialists
      can't do anything yet
- [ ] Reseller: saved-search fetchers for Poshmark / eBay / Vestiaire / RealReal / 1stDibs + stock inventory
- [ ] Chef: meal planner + food-inventory read/write (shares the inventory model with reseller stock)
- [ ] Finance: surfacing tools (read-only; **no money movement** per hard constraint)
- [ ] Dev: scoped repo/deploy helpers
- Parallel-safe: partially. New tool *modules* are isolated; wiring them into
  `runSpecialist` touches the bottleneck file. Pattern: build each tool as a
  standalone `{name, description, input_schema}` + handler in its own file, then
  one short integration commit adds them to the list.

### G. Browser automation (Playwright)  `[ ]`

Owns: new `src/channels/browser.js` (or `src/tools/browser.js`), `package.json` dep.

- [ ] Add local headless Playwright capability (deferred from the Chromebook era)
- [ ] Wire any ordering/purchase action **behind `confirm.js`** and through a tool
- Parallel-safe: **yes** — almost all new files. Only `package.json` overlaps
  (additive dep). Integration into the tool list overlaps F's bottleneck.

### H. Harden & operationalize  `[x]`

Owns: `src/queue.js`, `src/daemon.js`, `src/log.js`, `deploy/com.freyfam.cos.plist`.

- [x] **Dead-letter after N dequeues (2026-06-19):** `queue.js` parks poison messages
      (failed > `MAX_DEQUEUE`, default 5) on a dead-letter queue (`<inbound>-poison`,
      derived in `config.js`) and deletes them from the main queue so one bad message
      can't cycle forever. Original base64 body preserved for replay. Inspect the
      `-poison` queue later with any Storage queue browser.
- [x] **Structured logging (2026-06-19):** new `src/log.js` — dependency-free JSON-
      line logger (`LOG_LEVEL` env; warn/error → stderr → `cos.err.log`). All 15
      `console.*` sites across queue/daemon/heartbeat/cost migrated; `grep console.
      src/` is clean. Verified live (`npm run once` emits structured lines). Tested
      in `test/log.test.js` (format + stream routing + DLQ name). Suite 29/29 green.
- [~] `pmset` / `caffeinate` so it runs lid-closed on power (2026-06-19):
      `caffeinate -is` is now baked into the plist's ProgramArguments, so idle +
      system sleep on AC are prevented for the daemon's lifetime (verified:
      `pmset -g assertions` shows caffeinate pid holding both, on behalf of the
      node daemon). REMAINING: true lid-CLOSED on power needs one sudo command the
      daemon can't self-run — `sudo pmset -c disablesleep 1` (revert with `0`).
- [x] Install `deploy/com.freyfam.cos.plist` (2026-06-19): copied to
      `~/Library/LaunchAgents/`, `launchctl load -w`. Daemon runs under launchd
      (`com.freyfam.cos`, RunAtLoad + KeepAlive), survives reboots and auto-restarts.
      Logs: `cos.out.log` / `cos.err.log`. Plist paths already matched this machine.
- Parallel-safe: mostly yes — `queue.js` and `deploy/` are isolated. Touches
  `daemon.js` lightly. Independent of E/F/G.

### I. Multimodal / MMS intake  `[ ]`  — DO NOT DROP (deferred, cross-repo)

Promoted from a buried bullet under B so it stays visible. Today the front door
enqueues **text only**; inbound MMS images, vCards, and forwarded-voicemail audio
are silently dropped (no media field in the queue contract). This is the path to
photo intake, which the current roster actually wants:
- **Shey (reseller):** snap a photo of an item → catalog / draft a listing.
- **Carmen (chef):** photo of groceries or a receipt → update food inventory.
(This replaces the old "Sylvie" framing in the Genet gaps below.)

Owns (cross-repo): the queue *contract* + `~/freyfam-assistant` front door + this
repo's `queue.js`/`orchestrator.js`.

- [ ] Extend the queue message contract with a `media` field (Twilio `MediaUrlN` →
      `[{url, contentType}]`). Update BOTH sides and the contract test.
- [ ] Front door (B repo): include media URLs when `COS_ENQUEUE` is on.
- [ ] Daemon: fetch the media (Twilio media URLs need auth + expire) and build
      Claude image content blocks in `orchestrator.handleInbound`.
- [ ] Route image-bearing messages to the right specialist (Shey/Carmen) via triage.
- [ ] Keep the hard constraints: any resulting outbound still goes through Lloyd's
      confirmation gate + `guards.js`.
- Parallel-safe: yes once the contract field is pinned — front door and daemon sides
  can then proceed independently, same as B did.

### J. Cost watchdog  `[~]`  — code done & green; needs creds + live verify

Built 2026-06-19. Hourly, zero-model-token reads of month-to-date spend → SMS to
`OWNER_PHONE` (via the guarded Twilio path) when a billing cycle crosses
`COST_ALERT_USD` (default $100), re-alerting every `+COST_ALERT_STEP_USD` ($50) as
it climbs. De-duped per tier per cycle in `data/cost-alerts.json`. Both meters
no-op until their creds are set, so this is safe to ship dark.

Owns: `src/cost.js`, `src/heartbeat.js` (throttled call), `config.js` (`COST`),
`deploy/azure-budget.sh`, `test/cost.test.js`.

- [x] `src/cost.js`: Anthropic Admin `cost_report` + Azure Cost Management `query`
      readers, tier/cycle logic, local de-dupe state. Wired into the heartbeat on
      its own hourly cadence (`COST_CHECK_INTERVAL_MS`). Tests green.
- [x] `deploy/azure-budget.sh`: independent Azure-side budget backstop (action
      group + SMS at 80% / 100% / forecasted) that fires even when the Mac is off.
- [ ] **LATER — provision creds (no code, just `.env`):** `ANTHROPIC_ADMIN_KEY`
      (Console → Settings → Admin keys, org owner) and an Azure SP with the
      **Cost Management Reader** role (`az ad sp create-for-rbac --role
      "Cost Management Reader" --scopes /subscriptions/<id>`) → `AZURE_CLIENT_ID/
      SECRET/TENANT_ID` + `AZURE_SUBSCRIPTION_ID`. Keys already scaffolded (blank)
      in `.env`.
- [ ] **LATER — live-verify the read → SMS path:** `COST_ALERT_USD=0.01 npm run once`
      should text the owner within seconds; then revert. Flips this workstream to `[x]`.
- [ ] **LATER (optional) — run the Azure budget backstop:** `bash deploy/azure-budget.sh`
      (needs write RBAC, more than the read-only SP). Also set an Anthropic Console
      monthly spend limit (Settings → Limits) as the hard-cap the daemon can't enforce.
- Parallel-safe: yes — isolated except a one-line heartbeat call. Independent of all
  other workstreams; only shares `.env` and `config.js` with the rest.

---

## Suggested parallel session plan

Run these as separate Claude Code sessions; they barely touch each other:

| Session | Workstream | Files | Needs creds? |
|---------|-----------|-------|--------------|
| 1 | A: boot + verify | `.env` only | yes (all) |
| 2 | E: real memory | `memory.js`, `data/` | no (embeddings key only) |
| 3 | G: browser | new `browser.js`, `package.json` | no |
| 4 | H: hardening | `queue.js`, `daemon.js`, `deploy/` | no |
| 5 | C: Graph token | `graph.js`, config | yes (Graph) |
| 6 | B: Azure Function | external repo | yes (Azure) |
| 7 | J: cost watchdog verify | `.env` only | yes (Anthropic admin + Azure SP) |

**Bottleneck (serialize):** D (proactive bug) and F (specialist tools) both edit
`orchestrator.js`. Do D first (it's small and a real bug), then F. Or assign both
to one session.

**Critical path to "it works at all":** A → (B + C) → D. Memory, specialists, and
browser make it *good*; the path above makes it *live*.

## Deployment target & topology (CONFIRMED 2026-06-18, later milestone)

**Dev now:** everything on Nic's laptop (one process, specialists in-process — current code).

**Permanent (later):** split execution across the boundary —
- **Lloyd runs locally** on a dedicated always-on Mac. He keeps the front door:
  queue consumer, inbound triage, the **confirmation gate**, **all outbound channels**
  (Twilio/Graph), the `guards.js` read-only-domain check, and memory recall.
- **The five specialists run in the Azure tenant** (Patrick, Steve, Shey, Carmen,
  Frank) on **serverless, scale-to-zero compute (CONFIRMED 2026-06-19) — no always-on
  computing**. Lloyd's `delegate` tool calls out to them instead of running them
  in-process. This is why the `@azure/data-tables` dependency showed up — specialist
  state (saved-searches, proposals, meals, finance) moves to Azure Table Storage,
  co-located with the specialists.

### Cost & isolation model (CONFIRMED 2026-06-19)

The dominant cost (Anthropic tokens, ~$40/mo) **does not change** — a specialist makes
the same Claude calls wherever it runs. The hybrid only adds hosting + storage, and at
household volume that is small.

| Line | In-process (today) | **Hybrid serverless (chosen)** |
|------|--------------------|-------------------------------|
| Anthropic API | ~$40 | ~$40 |
| Specialist compute | $0 | ~$0-5 (Functions/Container Apps scale-to-zero, mostly in free grants) |
| Azure Tables | $0 | ~$0-1 |
| Twilio | ~$10 | ~$10 |
| Existing Function + Queue | ~$0-3 | ~$0-3 |
| Mac power (Lloyd) | ~$3-5 | ~$3-5 |
| **All-in** | **~$50-60** | **~$55-70 (+$5-10)** |

**Isolation comes from separate identity + separate storage per specialist, NOT from
keeping compute warm.** Each specialist = its own Function/Container App with its own
**managed identity** and **Table Storage scope**, so Patrick cannot read Carmen's data
or Lloyd's outbound channels, and a crash is contained — all while scaling to zero
between the household's episodic delegations. Always-on dedicated compute per agent
(the literal "one Mac Mini each") was **rejected**: ~$40-150/mo for no extra isolation
at this traffic. Trade-off accepted: serverless cold starts add ~1-5s per delegation.

### Identity & addressing model (CONFIRMED 2026-06-19)

Per-persona identity is **not** a cost driver — access isolation and email addresses
are different planes:

- **Access isolation = free.** Comes from Azure managed identities + scoped Graph
  app permissions (see cost model above), not from mailboxes. App registrations and
  managed identities cost $0.
- **Email = optional and mostly free.** Licensed M365 mailboxes (~$6/user/mo) are the
  trap; **shared mailboxes and aliases are $0**. Do NOT create six licensed mailboxes.

Decisions:
- **Primary CoS mailbox: `cos@freyfam.com`** (was `assistant@freyfam.com`). Keep
  `assistant@` as an **alias** so existing mail still lands — additive, reversible.
  Code: `GRAPH_MAILBOX` in `.env`; default updated in `config.js`. Provisioning the
  alias in M365 is an ops step (workstream A).
- **One Twilio number** for all of Lloyd's SMS — phone numbers ARE a per-identity
  cost (~$1-2/mo each), so personas do NOT get their own.
- **One outbound sender.** Lloyd owns all outbound, so nothing sends "as" a persona;
  no per-persona send identity needed.
- **Per-persona inbound routing only if wanted** (e.g. bank statements → `patrick@`,
  marketplace alerts → `shey@`): use **free shared mailboxes**, each scoped to its
  specialist via Graph **Application Access Policy**. Deferred until a real need.

### This supersedes a CLAUDE.md statement — flag for the owner

CLAUDE.md says specialists are "in-process personas the chief delegates to, **not
separate deployments**." This decision changes that. **Do not silently edit the hard
constraints** — confirm with Nic, then update CLAUDE.md's Architecture section so the
constitution matches reality.

### How to build NOW so the migration is cheap (guidance for in-flight work)

- **Keep specialist logic transport-agnostic.** The finance analyzer, meal planner,
  saved-search registry, proposal log etc. are pure functions + a store — that is
  exactly right and ports to Azure unchanged. Avoid baking in any assumption that
  `delegate` is an in-process call.
- **`delegate` is the seam.** Today it calls `runSpecialist()` locally; later it
  becomes an Azure invocation (Function / Container App / Durable). Keep its
  signature (`{agent, task} -> text`) stable so only the body changes.
- **Outbound + confirmation stay on Lloyd, always.** Specialists in Azure must never
  send directly; they surface actions and Lloyd's local confirmation gate + guard
  enforce the hard constraints. This keeps the read-only-domain guarantee intact
  regardless of where compute runs.
- **Decide where memory lives.** `memory.js` recall is currently local + agent-scoped.
  If Azure specialists need their own recall, the store likely becomes shared/Azure-
  hosted (Tables or a vector store). Open question — resolve before the Azure split.

### Migration checklist (extends workstream H, deferred)

- [ ] Confirm topology with Nic and update CLAUDE.md
- [ ] Move specialist stores from local JSON to Azure Tables (data-tables dep started)
- [ ] Stand up specialist compute in Azure — **serverless scale-to-zero** (Functions
      Consumption or Container Apps min-replica-0); one identity + Table scope per agent
- [ ] Reimplement `delegate` to invoke Azure specialists; keep signature stable
- [ ] Resolve memory location (local vs shared/Azure)
- [ ] Provision the dedicated Mac: `.env`, `npm install`, Node 22, `launchd` plist
      (edit machine-specific paths in `deploy/com.freyfam.cos.plist`), `pmset`/
      `caffeinate` for lid-closed always-on
- [ ] Verify the read-only-domain guard + confirmation gate still gate every
      outbound path after the split

## The Genet bar (concrete target)

Source: Jesse Genet's "5 OpenClaw agents" setup (How I AI / The Cut, 2026). She
runs her household on **five named specialist agents**, each on its **own Mac Mini**
with its **own email/identity** and **progressive trust** (limited access first,
expanded as it proves out). Each agent has a `soul.md` (persona) and a `decision.md`
(long-term log of final decisions). Her roster:

| Genet agent | Role | Notable capabilities | freyfam-cos status |
|-------------|------|----------------------|--------------------|
| **Claire** | Chief of staff / scheduling | iMessage, calendar, no finance access | ~ chief-of-staff exists; **no calendar/scheduling** (heartbeat TODO) |
| **Finn** | Finance | Read-only bank data, **isolated to a private Slack channel, no outbound** | ~ finance persona exists, **no tools**; our equivalent: SMS + "no money movement" guard |
| **Cole** | Dev | Full-stack app build + **deploy to physical devices** (built a kids' TV app) | ~ dev persona exists, **no tools** |
| **Sylvie** | Homeschool / creative | photo intake, image gen, printer, inventory | **replaced by → reseller** (`resale.md` exists, no tools) |
| **Theo** | Content creator | content generation | **replaced by → chef** (Carmen): persona + meal/inventory tools DONE on the shared Azure tables |
| _(none)_ | — | — | **+ security** (Frank): persona + advisory tools DONE; real monitors TODO |

**Roster (CONFIRMED 2026-06-18):** chief-of-staff, finance, dev, **reseller**,
**chef**, **security**.
The Frey household swaps Genet's homeschool/creative + content agents for a
**reseller** (already scaffolded as `resale`) and a **chef** (meal planning + food
inventory — net new), and adds a **security** agent (home + IT) that Genet's roster
did not have. Sylvie's *inventory* muscle is the relevant transferable capability:
it maps to the chef's food inventory and the reseller's stock.

**Agent names (Genet-style):** keep the role *key* used for routing (`resale`,
`chef`, …) but give each a name in its persona file, surfaced in copy.

| Role key | Name | Notes |
|----------|------|-------|
| chief-of-staff | **Lloyd** | confirmed 2026-06-18 |
| reseller (`resale`) | **Shey** | confirmed 2026-06-18 |
| chef | **Carmen** | confirmed 2026-06-18 |
| finance | **Patrick** | confirmed 2026-06-18 |
| dev | **Steve** | confirmed 2026-06-18 |
| security | **Frank** | confirmed 2026-06-18; persona `security.md` written |

### Architecture divergence (decide deliberately)

Genet uses **physical isolation** (one Mac Mini + one email per agent, role-based
access). freyfam-cos is **one daemon, in-process personas the chief delegates to**
(see CLAUDE.md). That's a legitimate, cheaper choice — but it means we get isolation
from **`guards.js` + per-agent scoped tools**, not from the OS. Action: make sure
each specialist's tool set is genuinely scoped (e.g. finance gets read-only tools
only) so we match Genet's *security posture* without her hardware.

### Capability gaps to hit the bar (maps to workstreams)

- [ ] **Calendar / scheduling** (Claire) — extends D/heartbeat (`heartbeat.js:23`
      TODO) + a scheduling tool in F. This is the biggest missing chief-of-staff muscle.
- [ ] **Photo / multimodal intake** — now its own first-class **workstream I**
      (inbound MMS → image content blocks). Roster fit: Shey (item photos), Carmen
      (groceries/receipts). See workstream I for the cross-repo plan.
- [ ] **Image generation** (Sylvie) — a creative tool (Gemini or another provider).
      New tool module → wired in F.
- [ ] **Printer access** (Sylvie) — local print tool (pairs with browser stream G).
- [ ] **Per-agent `soul.md` + `decision.md`** — `soul.md` ≈ our `agents/*.md`
      (rename/align concept); `decision.md` is the new decision-log in E.
- [x] **Add the `chef` agent (Carmen)** — done 2026-06-18:
      - [x] persona `src/agents/chef.md` (Kitchen & Meals — Carmen)
      - [x] `"chef"` in the delegate enum + both triage enums, with guidance
      - [x] chef tools (F): view/plan/remove meals, kitchen inventory list/summary/
        expiring-soon, add/consume items + scoped memory. Data layer `src/meals.js`
        is a faithful ESM port of the Azure-repo meal feature pointed at the SAME
        Tables (mealPlans/inventory/inventoryEvents) — shared with the reseller's stock.
      - [x] heartbeat feeds items expiring within 2 days as signals -> routed to chef
      - NOTE: first shipped under key `carmen` (commit f36a2f8); realigned to key
        `chef` (name stays Carmen) to match this tracker's role-key convention.
- [x] **Add the `security` agent (Frank)** — done 2026-06-18:
      - [x] persona `src/agents/security.md` (Frank)
      - [x] `"security"` in the delegate enum + both triage enums, with guidance
      - [x] security tools (F): scoped memory + `log_security_finding` /
        `list_security_findings` (advisory log `src/security.js`). Frank flags;
        humans act. All control actions (arm/disarm, lock, password/account changes)
        stay behind the chief's confirmation gate.
      - [ ] real read-only signal monitors (auth/login events, breach feeds, device/
        update status, home-system alerts) — need external integrations; TODO
      - [ ] heartbeat security feed via `gatherSignals()` (kitchen feed landed as the
        pattern; security monitors still TODO)
- [ ] **Progressive trust** — start specialists with minimal tools, widen over time.
      Bake into F by gating powerful tools behind config flags.
