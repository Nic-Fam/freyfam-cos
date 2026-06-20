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

### C. Graph / mailbox token debug  `[x]`  — DONE 2026-06-19

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

### D. Fix the proactive path bugs  `[x]`  — DONE 2026-06-19

Owns: `src/heartbeat.js`, and a few lines of `src/orchestrator.js`.

- [x] **Heartbeat results now reach the owner.** Root cause was the heartbeat
      faking an inbound SMS (`from:"heartbeat"`), which made `handleInbound` call
      `sendSms("heartbeat", text)` and throw. Fix: extracted `runChief(body, model)`
      in `orchestrator.js` — runs the chief agent loop and RETURNS text without
      sending. `handleInbound` now uses it then sends per channel (external behavior
      unchanged); the heartbeat calls `runChief` directly and `notifyOwner(result)`.
- [x] **No more double-triage.** The heartbeat no longer round-trips through
      `handleInbound` (which re-ran `triageInbound`). It runs the chief directly at a
      tier chosen from urgency (`now` → heavy, else standard), since `triageHeartbeat`
      already judged the item. Removes the redundant triage call per escalation.
- Verified: 29/29 tests green; `npm run once` runs clean. (Live escalation delivery
  needs a genuinely actionable signal to exercise end-to-end, but the structural bug
  — the throwing send — is gone.)

### E. Real memory  `[~]`  — near-term items DONE 2026-06-19; embeddings still deferred

Owns: `src/memory.js`, `src/decisions.js`, new `data/` seed scripts. Interface
(`recall`/`remember`) stayed stable so callers didn't change.

- DECISION (2026-06-18): **embeddings deferred** — keep `embedHash()` for now,
  revisit when the corpus grows. So the two items below are *not* near-term.
- [ ] (deferred) Replace `embedHash()` (`memory.js:30`) with a real embedding call
- [ ] (deferred) Swap JSON store for sqlite-vec or LanceDB (keep signatures)
- [x] **Seed from the family's existing notes (2026-06-19).** `data/seed-notes.json`
      holds editable family notes (`{text, meta.agent?}`; omit `agent` for shared
      facts). `data/seed.mjs` (`npm run seed`) loads them into the hash store via a
      new additive `rememberOnce()` export — idempotent (dedupes by exact text), so
      re-running never piles up duplicates. Honors `BRAIN_PATH`. Verified: 8 added on
      first run, 0 on the second. Starter notes are grounded in CLAUDE.md (timezone,
      members, read-only domains, no-em-dash style, oat milk, resale sites,
      no-money-movement); the family edits the JSON to add more.
- [x] **Genet `decision.md` per-agent decision log (2026-06-19).** `src/decisions.js`:
      `logDecision(agent, {title, decision, rationale?, context?})` (append-only) +
      `listDecisions(agent)` (newest-first). Canonical per-agent JSON under
      `data/decisions/<agent>.json`, with a human-readable `<agent>.md` regenerated on
      every write so it can't drift. Agent key is filename-sanitized (no path escape).
      Wired as scoped `log_decision`/`list_decisions` tools on ALL five specialists
      in `agents/tools.js` (shared helper like `memoryTools`) AND on the chief in
      `orchestrator.js` — the chief writes to its own log but `list_decisions` takes an
      optional `agent` so Lloyd can review any specialist's decisions. Logging takes no
      real-world action — high-stakes effects still go through the chief's gate.
- Parallel-safe: **yes, fully isolated** — `memory.js` + `decisions.js` + `data/`,
  plus additive, non-conflicting tool wiring in `agents/tools.js` and `orchestrator.js`.
  `_smoke.mjs:16-20`
  + `test/memory.test.js` + new `test/decisions.test.js` pin the contracts (34/34 green).

### F. Specialist tools  `[x]`  — all six wired 2026-06-19

Owns: `src/specialists/runner.js`, `src/agents/tools.js` (per-agent registry),
`src/agents/*.md`, the domain modules below.

`runSpecialist` (`src/specialists/runner.js`) loads each agent's persona + scoped
tools from the `REGISTRY` in `src/agents/tools.js`. Every specialist also gets
agent-scoped **memory** (recall/remember) and a **decision log** (log/list), so one
domain's memory never pollutes another's. Hard constraint held: specialists only
RETURN text and have side-effect-light tools — no outbound, no confirmation power.

- [x] Finance (Patrick): `analyze_transactions` (pure spending analysis; **never
      moves money**) — `src/finance.js`.
- [x] Reseller (Shey): saved-search registry add/list/remove — `src/saved-searches.js`.
- [x] Dev (Steve): change-proposal log propose/list (**never deploys**) — `src/proposals.js`.
- [x] Chef (Carmine): meal planner + food-inventory read/write — `src/meals.js`.
- [x] Security (Frank): findings add/list with severities — `src/security.js`.
- [ ] FUTURE depth (not blocking): live marketplace fetchers for the resale sites
      (Poshmark/eBay/Vestiaire/RealReal/1stDibs) — needs network + per-site selectors,
      overlaps G (browser).
- Tested across `test/finance|saved-searches|proposals|meals|security|tools.test.js`.

### G. Browser automation (Playwright)  `[~]`  — capability + tools landed 2026-06-19

Owns: new `src/channels/browser.js`, `package.json` dep.

- [x] **Local headless Playwright capability (2026-06-19).** `src/channels/browser.js`:
      Playwright is a lazy, **optional** dep (`import("playwright")` inside the call;
      friendly install hint if absent) so the daemon, tests, and every non-browser
      path keep working without the browser binary installed. Shared headless
      chromium launched on first use; `closeBrowser()` releases it (wired into
      `daemon.js` shutdown, no-op when nothing launched). Transport-agnostic: the
      module is a pure capability and never confirms anything itself, so it survives
      the eventual local/Azure split unchanged.
- [x] **Read-only browse tool.** `readPage(url)` opens one page and returns
      title + visible text. No clicks/fills/navigation. Exposed to the chief as
      `browse_page` for price/listing/availability checks.
- [x] **Ordering wired behind `confirm.js` (2026-06-19).** `runOrder({url, steps})`
      drives a goto/click/fill/waitFor checkout flow. Exposed to the chief as the
      high-stakes `place_order` tool: handler calls `requestConfirmation` first
      (same pattern as `send_email`) and bails on decline. **Hard constraint kept:**
      `assertOutboundAllowed()` runs inside `runOrder` before any launch AND on every
      `goto` step, so a browser action can never reach a read-only work domain.
- [x] **Tests:** `test/browser.test.js` covers the guard (read-only domains rejected
      before launch), input validation, and the safe `closeBrowser()` no-op. Designed
      to pass with or without Playwright installed (only pre-launch paths). Suite green.
- [ ] **REMAINING — live verify:** `npm i playwright && npx playwright install chromium`,
      then drive a real read (`browse_page`) and a sandbox checkout through the
      confirmation gate end-to-end. Flips this workstream to `[x]`.
- [ ] **REMAINING — real selectors per site.** `steps` are generic primitives today;
      per-site order flows (the resale sites) still need concrete selectors, ideally
      surfaced as the resale specialist's saved-search fetchers (overlaps F).
- Parallel-safe: **yes** — almost all new files. Only `package.json` (additive
  optional dep) and the chief's tool list in `orchestrator.js` overlap; integration
  into specialist tool lists overlaps F's bottleneck.

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
- **Carmine (chef):** photo of groceries or a receipt → update food inventory.
(This replaces the old "Sylvie" framing in the Genet gaps below.)

Owns (cross-repo): the queue *contract* + `~/freyfam-assistant` front door + this
repo's `queue.js`/`orchestrator.js`.

- [ ] Extend the queue message contract with a `media` field (Twilio `MediaUrlN` →
      `[{url, contentType}]`). Update BOTH sides and the contract test.
- [ ] Front door (B repo): include media URLs when `COS_ENQUEUE` is on.
- [ ] Daemon: fetch the media (Twilio media URLs need auth + expire) and build
      Claude image content blocks in `orchestrator.handleInbound`.
- [ ] Route image-bearing messages to the right specialist (Shey/Carmine) via triage.
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

## Deployment target & topology (UPDATED 2026-06-19 → hybrid 3-tier)

**Dev:** everything in one process, specialists in-process (still the default when
no endpoint is set — graceful fallback).

**Confirmed running topology — three tiers:**
- **Local Mac fleet (household LAN):**
  - **Lloyd** (chief) on a Mac mini — front door, queue consumer, inbound triage,
    **confirmation gate**, **all outbound channels**, `guards.js`, memory recall.
  - **Frank (security)** on a Mac mini — local for home-network/security access +
    keeping that data on-prem.
  - **Steve (dev)** on an old MacBook — local for code/device access.
  - Frank + Steve run `deploy/specialists/local-server.mjs` (`npm run specialist`):
    a plain HTTP harness serving the SAME `{agent,task}->{text}` contract + key auth
    + agent pin as the Azure handler. Lloyd reaches them over the LAN.
- **Azure (serverless Flex Consumption, scale-to-zero):** **finance (Patrick),
  resale (Shey), chef (Carmine)** — one Function app each, own managed identity +
  Table scope. (finance verified end-to-end on Flex.)
- **Seam:** `delegate` POSTs `{agent,task}` to `cfg.endpoints[agent]`; Azure vs LAN
  is just the host. No URL → that specialist runs in-process on Lloyd.

CHANGE 2026-06-19: Frank + Steve moved OUT of Azure to local Macs. Done in repo:
`provision-`/`publish-specialists.sh` AGENTS default is now `finance resale chef`;
local harness + `npm run specialist` added; `.env.example` documents per-tier URLs.
- [ ] **Decommission any dev/security Azure apps** if a prior run provisioned them
      (`freyfam-cos-dev`, `freyfam-cos-security`) — they should not exist in Azure now.
- [ ] Set LAN URLs + keys for dev/security in Lloyd's `.env` once the Macs are online.

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
**managed identity** and **Table Storage scope**, so Patrick cannot read Carmine's data
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

### Migration checklist (extends workstream H)

Started 2026-06-19. Three decisions locked with Nic this session: **compute =
Azure Functions (Consumption)**; **memory = per-specialist Table-scoped store +
managed identity** (NOT shared, NOT callback-to-Lloyd); **approach = code seam
first, verify locally, then provision**.

- [x] **Confirm topology with Nic and update CLAUDE.md (2026-06-19).** Architecture
      section now describes the built seam; the "where memory lives" open question is
      resolved (per-specialist Azure store) in CLAUDE.md.
- [x] **Reimplement `delegate` to invoke Azure specialists; keep signature stable
      (2026-06-19).** Seam built and verified locally:
      - `src/delegate.js` — `chooseTransport` (local unless `mode=remote` AND the
        specialist has an endpoint), `invokeRemoteSpecialist` (POST `{agent,task}` →
        text, `x-functions-key` auth, `AbortController` timeout), and `delegate()`.
        Remote failure does NOT fall back to local (that would run a specialist with
        Lloyd's scope and break isolation) — it returns a graceful message.
      - `src/specialists/runner.js` — the transport-agnostic execution core (moved
        out of `orchestrator.js`); this is the unit that deploys to each Function.
      - `src/persona.js` — shared persona loader (chief + runner).
      - `config.js > SPECIALISTS` — `COS_SPECIALIST_MODE` (default `local`), per-agent
        endpoint env vars, function key, timeout.
      - `orchestrator.js` delegate handler now calls the seam; default behavior
        (in-process) is unchanged. Tests: `test/delegate.test.js` (routing + remote
        HTTP via a real stub server + no-silent-fallback). Suite 39/39 green.
- [x] **Resolve memory location (2026-06-19): per-specialist Azure store** under each
      specialist's own managed identity. `recall`/`remember` + `logDecision`/
      `listDecisions` interfaces stay stable, so it's a store swap inside the runner,
      not a caller change. (See CLAUDE.md Topology.)
- [x] **Specialist compute LIVE on Flex Consumption (2026-06-19).** finance / resale /
      chef / security each run as their own Flex Consumption Function (Running),
      system-assigned identity scoped to their own `brain<agent>` table, deployed via
      `--build remote`. The full remote path is VERIFIED: `delegate` → HTTPS + per-agent
      function key → live Flex Function → `runner.js` → persona + Claude → text. finance
      even exercised its `analyze_transactions` tool remotely (caught a duplicate charge).
      Hard-won lessons (all in the scripts/README now): classic Linux Consumption hosts
      would not start in this sub/region (503 everywhere) → use **Flex**; Flex needs
      **`--build remote`** explicitly (its default deploy skipped Oryx → empty function
      list); `EnableWorkerIndexing` required for the v4 Node model; role assignment via
      `--assignee-object-id` to dodge the AAD replication race. **dev intentionally NOT on
      Azure** — it stays in-process/local (Chromebook host = later milestone) because its
      build/deploy/device work needs a stateful, tool-rich box, not scale-to-zero serverless.
      CUTOVER: only **finance** is safe to flip remote now (stateless); resale/chef/security
      stay `local` until their domain stores move onto the managed-identity Table path.
- (kit, for reference) provisioning + publish scripts under `deploy/`:
      - `deploy/specialists/app/specialist.mjs` — Function handler wrapping
        `runner.js`; `authLevel:function`, `COS_AGENT` pin, returns `{text}` only.
      - `deploy/specialists/{host.json,package.json,README.md}` — Functions v4 host +
        the runner's runtime deps (`@anthropic-ai/sdk`, `@azure/data-tables`) + docs.
      - `deploy/provision-specialists.sh` — one Consumption app per specialist, each
        with its own system-assigned identity scoped (`Storage Table Data Contributor`)
        to ONLY its own table. That per-app identity + per-table RBAC is the isolation.
      - `deploy/publish-specialists.sh` — bundles `src/` + host into a temp dir,
        deploys to each app, prints the per-agent `.env` block (URL + key).
      - Per-agent keys supported on Lloyd's side (`config.SPECIALISTS.keys`,
        `delegate.js`); `.env.example` documents all vars. `bash -n` + `node --check`
        clean; suite 44/44 green.
      - **BLOCKING caveat (in the README):** the runner's memory/decision log write
        local JSON; on a Consumption Function that's ephemeral + unscoped. Remote mode
        is verified for *stateless* reasoning now; the Tables-backed store (next item)
        must land before remote specialists have persistent recall. Provisioning
        already wires `COS_TABLE_ENDPOINT`/`COS_TABLE_NAME` + the scoped identity for it.
- [~] **Move specialist stores onto the per-specialist MI Table path** (the pluggable
      `src/stores/collection.js`: local JSON by default, the specialist's own
      `brain<agent>` table when `COS_TABLE_*` is set):
      - [x] `decisions.js` (done earlier this session)
      - [x] **`saved-searches.js` (resale) — DONE + LIVE 2026-06-19.** Migrated to the
        collection store (+ `remove()` on both backends). Verified end-to-end: a
        `delegate` → remote resale Flex Function → `add_saved_search` wrote a row to
        `brainresale` via the Function's managed identity (isolation intact, MI scoped
        to that one table). **resale flipped remote** in the live `.env`. Gotcha logged:
        the first failures were a RED HERRING — stale deployed code (pre-migration
        `saved-searches.js`) hit `mkdir ./data` EACCES on the read-only Flex FS and the
        agent narrated it as a "permission error"; RBAC/MI were fine all along. Lesson:
        **redeploy after a store migration** before blaming Azure.
      - [x] **`meals.js` (chef) — DONE + LIVE via Option 3 (2026-06-19).** Relocated the
        meal tables (mealPlans, inventory, inventoryEvents) to the specialists storage
        account and switched `meals.js` to choose auth like `collection.js` (connection
        string locally, managed identity + `COS_TABLE_ENDPOINT` on the Function).
        `ensure()` now tolerates 403 (table-scoped MI can't create tables; pre-created
        at provision). chef's MI granted on all 3 meal tables + brainchef. Verified:
        `delegate` → remote chef Flex Function → `plan_meal` wrote to mealPlans on the
        specialists account via MI. **chef flipped remote.** Migrated 2 ledger rows.
        CROSS-REPO TODO: the Azure-repo meal feature still points at the old account
        (`freyfamassistant8a4f`, now empty) — repoint it to `freyfamcosspec31547` or
        retire it. Done in THIS repo; that change lives in `~/freyfam-assistant`.
      - [ ] `memory.js` — owned by the parallel recall workstream; still local JSON, so
        remote specialists' `recall`/`remember` don't persist yet (decisions + saved
        searches do). finance/resale work fine without it for now.
- LOCAL specialists (Frank=security, Steve=dev) use `deploy/specialists/local-server.mjs`
  (`npm run specialist`) — verified this session: same `{agent,task}->text` contract,
  x-functions-key auth (401), agent pin (403), round-trip via `delegate`. **Steve →
  Mac mini next week is plug-and-play**: run it with `COS_AGENT=dev` + a LAN key, set
  `COS_SPECIALIST_URL_DEV`. The orphaned Azure `freyfam-cos-security` app was TORN
  DOWN 2026-06-19 (security is local now); its empty `brainsecurity` table remains
  on the storage account (harmless, ~$0). Azure now hosts exactly finance/resale/chef.
- [ ] Provision the dedicated Mac: `.env`, `npm install`, Node 22, `launchd` plist
      (edit machine-specific paths in `deploy/com.freyfam.cos.plist`), `pmset`/
      `caffeinate` for lid-closed always-on
- [ ] Verify the read-only-domain guard + confirmation gate still gate every
      outbound path after the split (specialists return text only; runner carries no
      channel — invariant documented in `runner.js`)

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
| **Theo** | Content creator | content generation | **replaced by → chef** (Carmine): persona + meal/inventory tools DONE on the shared Azure tables |
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
| chef | **Carmine** | confirmed 2026-06-18 |
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
      (inbound MMS → image content blocks). Roster fit: Shey (item photos), Carmine
      (groceries/receipts). See workstream I for the cross-repo plan.
- [ ] **Image generation** (Sylvie) — a creative tool (Gemini or another provider).
      New tool module → wired in F.
- [ ] **Printer access** (Sylvie) — local print tool (pairs with browser stream G).
- [~] **Per-agent `soul.md` + `decision.md`** — `decision.md` DONE (E, 2026-06-19):
      `src/decisions.js` + per-agent `data/decisions/<agent>.md`, exposed as
      `log_decision`/`list_decisions` on every specialist. `soul.md` ≈ our
      `agents/*.md` (rename/align concept) — still TODO.
- [x] **Add the `chef` agent (Carmine)** — done 2026-06-18:
      - [x] persona `src/agents/chef.md` (Kitchen & Meals — Carmine)
      - [x] `"chef"` in the delegate enum + both triage enums, with guidance
      - [x] chef tools (F): view/plan/remove meals, kitchen inventory list/summary/
        expiring-soon, add/consume items + scoped memory. Data layer `src/meals.js`
        is a faithful ESM port of the Azure-repo meal feature pointed at the SAME
        Tables (mealPlans/inventory/inventoryEvents) — shared with the reseller's stock.
      - [x] heartbeat feeds items expiring within 2 days as signals -> routed to chef
      - NOTE: first shipped under key `carmen` (commit f36a2f8); realigned to key
        `chef` (name stays Carmine) to match this tracker's role-key convention.
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
