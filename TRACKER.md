# TRACKER.md - Frey Family Chief of Staff

Development tracker for getting the daemon from "scaffold that compiles" to
"agents that actually work" (the Genet-grade bar). Read **CLAUDE.md** first for
architecture and hard constraints; this file tracks *state* and *who-can-do-what-
in-parallel*.

Last synced to code: 2026-06-29 (LATER: real-time email webhook cutover + mini nightly git-sync; the 15-min daemon reconcile is now retired. Earlier same day: email reconcile + TRR returns; legacy app trimmed to Alexa/inventory).

## Status legend

- `[ ]` not started
- `[~]` scaffolded but unverified (code exists, never run against real creds/data)
- `[x]` done and verified
- `[!]` known bug / blocker

## Where we actually are

**The assistant is built and live.** Inbound (SMS via the deployed Azure front door +
email) → triage → specialist → reply runs under launchd, hardened (dead-letter,
structured logging, no-sleep) with a cost watchdog. All six agents (Lloyd, Patrick,
Steve, Shey, Carmine, Frank) have real scoped tools reachable through the `delegate`
seam. The Azure split shipped: finance/resale/chef run remote on Azure with
managed-identity Table stores; Lloyd + Frank + Steve are the local Mac fleet.

A → Q core is done (cost watchdog J and Slack K are LIVE as of 2026-06-23; the
per-agent tool allowlist K#4 is enforced). What remains is mostly **hardware** —
stand up the Mac fleet, and stand up the **BlueBubbles iMessage server** (Twilio SMS
was closed 2026-06-23; iMessage is the replacement text channel, code-ready and
disabled pending that server). Plus a few **live verifies** (G browser, now partly
captured) and **future features** (voice M, image-gen/printer, CVS Rx live). Details
in the per-workstream sections and the topology section below.

`_smoke.mjs` covers guards + confirm parser + memory round-trip with zero network.
Run it anytime with `node _smoke.mjs` (no creds needed). `npm test` runs the full
suite (~300 tests).

**Real-time email cutover + mini hardening (2026-06-29, later session):**
- **Inbound email is now REAL-TIME via the Graph webhook front door** (supersedes the
  15-min daemon reconcile below). Re-enabled the **cloud trio** in `freyfam-assistant`
  host.json allowlist — `email-handler` (Graph change-notification webhook, runs in
  `COS_ENQUEUE=true` mode: validate → mark read → enqueue to `inbound-messages` →
  record id in the `cosinboundseen` table), `email-reconciler` (timer backstop for
  dropped notifications, shares the same dedup table), `subscription-renewer` (daily,
  keeps the ~3-day sub alive). The mini consumes the queue in seconds. Storage is
  shared (`freyfamassistant8a4f`), so app + mini hit one queue.
- **Mini daemon reconciler RETIRED in tandem.** `heartbeat.js` gates
  `maybeReconcileInboundEmail` behind `COS_EMAIL_RECONCILE_ENABLED` (commit 08ba9df on
  main); the mini's `.env` sets it `=false`. Running BOTH reconcilers double-enqueues
  (disjoint dedup: cloud `cosinboundseen` table vs mini local `reconciled-emails.json`).
  **Cutover artifact:** when the webhook went live it replayed Graph's backlog of
  notifications for that morning's still-UNREAD mail → ~20 min of duplicate replies to
  Nic + Shelli (16:48–17:10), self-limited once those were marked read. LESSON: before
  flipping a webhook on over a polling daemon, mark the inbox read / pre-seed the shared
  dedup store so the backlog doesn't replay.
- **Mini nightly git-sync (was kickstart-only).** `com.freyfam.cos.restart` now runs
  `/Users/lloyd/cos-ops/restart-from-main.sh` (fetch + `reset --hard origin/main` +
  `npm install` + `node --check` with rollback + kickstart). The mini auto-pulls latest
  `main` every 4am. Its checkout is now clean on main (was 3 ahead / 5 behind; the
  ahead-only browser macOS fix was pushed to main as 659255e first).
- **MacBook retired as Lloyd / SSH access set up.** Mini (`lloyd@lloyd.local`, user
  `lloyd`, `/Users/lloyd/freyfam-cos`, launchd uid 501) confirmed sole live Lloyd; the
  MacBook's launchd plists were archived so it can't revive as a duplicate. See the
  `realtime-email-front-door` and `mini-ssh-and-deploy` memories.

**Recently shipped (2026-06-28 → 06-29), not mapped to a letter:**
- **Digest follow-up / action-clearing loop.** The digest was status-GUESSING (dropping
  a finished tour with no follow-up; calling an ongoing resale "trace" over). Fix: a
  grounded lifecycle on the existing task store. The digest now reviews YESTERDAY
  (`list_calendar` gained a `back` param; `familyDateWindow`/`listEvents` look back),
  auto-creates a follow-up task for a notable just-passed event (e.g. "Follow up: email
  Deborah re: tour"), surfaces every OPEN follow-up, and closes with "reply 'done
  <item>'" -> `complete_task`. Hard rule added (digest + chief persona): never assert a
  task/hunt/tour is "over/done" unless `list_tasks` says so or the family said so;
  resale traces are ongoing (report new results, never "finished"). Covers the Deborah,
  Elisha, Dsquared-trace, MSGM cases uniformly.
- **Printer access** (Genet gap) — `src/channels/printer.js` local CUPS; chief tools
  `print_document`/`list_printers`, audited. Plus the finance `checking-balance` store
  moved onto the collection store (last raw-file holdout; all finance stores now
  Table-ready). Both 2026-06-29.
- **Email intake moved onto the daemon (self-healing).** [SUPERSEDED 2026-06-29 by the
  real-time webhook above — this 15-min reconcile is now gated OFF on the mini via
  `COS_EMAIL_RECONCILE_ENABLED=false`; kept only as the in-repo default for non-webhook
  deployments.] Root cause of "Lloyd can't
  reach Patrick": the legacy Azure front door's Graph webhook was silently dropping
  family email, so questions never reached Lloyd. New `src/email-reconcile.js`
  (heartbeat `maybeReconcileInboundEmail`) reads the cos mailbox each tick and
  enqueues any not-yet-seen FAMILY email in the front-door envelope; first run
  baselines so it never replays history; dedup by Graph id; alerts/self excluded.
  Email no longer depends on any webhook. (`recentInboxFull` added to graph.js.)
- **Legacy `freyfam-assistant` decommissioned.** Stopped, then redeployed with a
  host.json `functions` allowlist of **alexa-skill + inventory-* ONLY** (Flex rejects
  per-function Disabled settings). The daemon now owns email/digest/reminders; the
  legacy app serves only the Alexa grocery skill + inventory API, **same endpoint**
  so no Alexa-console re-pointing. SMS/Twilio fully retired; iMessage still pending
  the BlueBubbles bridge (only live channels now: email + Slack).
- **Finance grounded in real statements.** Verified/corrected obligations against two
  months of the real joint checking (...1857): real due-days + amounts (rent day 1,
  card ~day 6, car/USF ~day 1, Edison end-of-month, two student loans ~$750, etc.),
  removed a bogus AAA monthly (it is an annual card charge), added Fidelity/Protective
  Life/Pilates/misc-Zelle services. `transfer_outlook` recomputed: ~$22,568 once-a-
  month (or a $5.1k + $17.4k split, both pre-Jul-6 since the card payment is the wall).
- **Patrick reachability.** Azure finance Function was 404/aborting (delegate has no
  silent local fallback by design). Redeployed it, then chose **in-process** anyway:
  scale-to-zero cold start exceeds the 30s delegate timeout AND the remote Table store
  has none of the seeded finance data. Finance runs local; remote cutover blocked on
  data migration + warm-up (noted in memory).
- [x] **TheRealReal returns reconcile (Shey + Patrick)** — `src/resale-returns.js` +
      tools `resale.check_returns` (reads TRR orders page via the signed-in Chrome
      profile) and `finance.reconcile_returns` (matches returns to card charges/credits
      -> outstanding credit). TRR is the only resale site whose returns move the budget.
      - [~] **DEFERRED: point the browser at the signed-in profile.** `check_returns`
        needs `BROWSER_USER_DATA_DIR` (+ `BROWSER_CHANNEL=chrome`) set to the
        TRR-logged-in Chrome profile, else it reads a logged-out page. Playwright is
        installed; only the profile path is missing. Deferred by Nic 2026-06-29.
- [x] **Frank (security) Mac mini LIVE end-to-end 2026-06-30** (provisioned 2026-06-29;
      cred gap resolved). This box (`/Users/frank/freyfam-cos`, LAN `192.168.50.117` /
      `Frank.local`) now runs the security specialist HTTP harness
      (`deploy/specialists/local-server.mjs`) on port `8787`. Done: Node v22.23.1, deps
      synced, `_smoke.mjs` + full `npm test` (363/363) pass, embeddings model cached.
      `.env` sets `COS_AGENT=security` / `PORT=8787` / `COS_SPECIALIST_LOCAL_KEY`
      (= Lloyd's `COS_SPECIALIST_KEY_SECURITY`, `c3c26d4c...`). Contract verified end to
      end: 401 (no key), 403 (wrong-agent pin), 400 (no task), 405 (GET), and a valid
      request passes every gate into the runner. Installed under launchd as
      `deploy/com.freyfam.frank.plist` → `~/Library/LaunchAgents/com.freyfam.frank.plist`
      (RunAtLoad + KeepAlive under `caffeinate -is`; KeepAlive auto-restart verified).
      Power (AC) already correct for an always-on mini: never idle-sleeps, autorestart
      after power failure, wake-on-network; no lid so no `disablesleep`; firewall off.
      Setup guide: `deploy/setup/frank-mac-mini.md`. **Open actions to finish:**
      - [x] **Real `ANTHROPIC_API_KEY` — DONE (verified 2026-06-30).** Frank's `.env`
            holds a real key; an authed `delegate({agent:"security"})` returned real model
            text ("READY"), so reasoning works end to end. (Earlier placeholder blocker
            resolved.)
      - [x] **Wire Lloyd → Frank (on Lloyd's box). DONE 2026-06-30.** Lloyd's `.env`:
            `COS_SPECIALIST_URL_SECURITY=http://192.168.50.117:8787/` +
            `COS_SPECIALIST_KEY_SECURITY` (= Frank's `COS_SPECIALIST_LOCAL_KEY`,
            `c3c26d4c...`); `COS_SPECIALIST_MODE=remote` already set. Lloyd restarted.
            Verified: `chooseTransport("security")` → `remote`; an authed
            `delegate({agent:"security"})` round-tripped over the LAN with HTTP 200 and
            real text (1.3s), so Frank's `ANTHROPIC_API_KEY` is now live too (the earlier
            placeholder blocker is resolved). `resale` correctly stays local.
            **Regression found + fixed 2026-06-30:** the mini `.env` had a DUPLICATE
            `COS_SPECIALIST_KEY_SECURITY` whose 2nd (last-wins under `--env-file`) value
            was an unfilled placeholder `<Frank's…>` carrying a Unicode ellipsis (U+2026).
            That crashed the `x-functions-key` header (ByteString error), so EVERY security
            delegate failed with "could not reach the security specialist." Removed the
            placeholder line, restarted Lloyd, re-verified "READY". Keep `.env` keys
            single-valued — a stray duplicate silently shadows the real one.
      - [x] **Reserve a static DHCP lease** for `192.168.50.117` — DONE (Nic, 2026-06-30).
      - [x] **Seed Frank's brain** — DONE (Nic, 2026-06-30).
      - [x] **Nightly git-sync for Frank — DONE 2026-06-30.** `com.freyfam.frank.restart`
            (4am) runs `/Users/frank/cos-ops/restart-from-main.sh` (fetch + reset --hard
            origin/main + npm install + `node --check` of the harness with rollback +
            kickstart `com.freyfam.frank`). Test-run synced Frank to latest main and the
            `delegate({agent:"security"})` round-trip still returns text. Mirrors Lloyd's
            mini job. **Frank fully live + self-updating.**
      - [x] **Frank network device monitor — DONE 2026-07-01.** `deploy/security/netscan.mjs`:
            ping-sweep + ARP diff of the local /24 vs gitignored `data/network-baseline.json`;
            `--record-findings` logs each unknown device as a `medium` security finding in
            Frank's local store (MAC-keyed, deduped so re-runs don't spam).
            `deploy/com.freyfam.frank.netscan.plist` = 30-min launchd timer (staged in repo;
            install with `cp` to `~/Library/LaunchAgents/` + `launchctl bootstrap`). Lloyd side:
            `heartbeat.maybeNetworkScan()` pulls Frank's open new-device findings over the LAN
            delegate and `notifyOwner`s them — detection on Frank, outbound on Lloyd (constraint
            2); inert unless security is wired remote, hourly via `NETWORK_SCAN_INTERVAL_MS`.
            First scan flagged a **Lorex device (192.168.50.222) on the MAIN subnet** — verify
            it's the NVR mgmt interface vs a leak off the segmented camera subnet.

**Recently shipped (2026-06-23 → 06-25), not mapped to a letter:**
- **Inbound image intake hardened** — byte-sniffed `media_type` + iPhone **HEIC→JPEG**
  transcode + graceful skip-with-reason (fixes the Slack/resale "Could not process
  image" failure); shared across MMS/Slack/iMessage (extends I).
- **iMessage attachment parity** — images→vision, PDF/.ics/.vcf (incl. vCards)→document
  extraction, matching the Slack/email front doors (extends I/L).
- **Hands-off package tracking** — carrier no-reply shipping mail is carved out of the
  auto-reply suppressor + a proactive heartbeat scan records tracking numbers; plus
  **owner attribution + pickup-location detection** and **auto-proposed pickup calendar
  events** (Shelli ASAP, Nic next free slot; through the confirmation gate).
- **Email CC/BCC** — real `ccRecipients`/`bccRecipients` (was body-text only, so CCs
  never sent).
- **Calendar weekday fix** — `list_calendar` attaches an authoritative `day` label so
  the model stops misnaming days (e.g. Sat Jun 27 as "Friday").
- **Resale** — Farfetch + Grailed added to Shey's marketplace coverage (persona).
- **Morning digest** — shows only the first work event of the day.
- **Restart discipline** — always restart from `main` (runbook + memory); see R.

---

## Workstreams

Each workstream lists the files it owns so parallel sessions don't collide. The
**serial bottleneck is `orchestrator.js`** (tool list + handlers) - try to keep
only one session editing it at a time, or merge changes through small, additive
tool entries.

### A. Boot & verify the loop  `[x]`  — DO FIRST, blocks B/C/D verification

Owns: `.env`, local run only. No code changes expected.

Last verified: 2026-06-19 (MacBook). **Re-verified on Lloyd's Mac mini 2026-06-29:**
`node _smoke.mjs` all green (guards/confirm/memory round-trip); the live daemon is
healthy (pid under launchd `com.freyfam.cos`, heartbeat scheduled, Slack socket
connected, queue consuming). The full loop runs in production on the mini, so A is
done there. (`npm run once` deliberately NOT run on the live mini — it would collide
with the running daemon's iMessage port + Slack socket; the live loop already proves it.)

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
- [x] **Twilio SMS path CLOSED (2026-06-23) — text channel pivots to iMessage.** The
      toll-free verification for +18777680783 was rejected/closed, so Twilio SMS is no
      longer the inbound/outbound text channel. The replacement is **iMessage** via a
      self-hosted BlueBubbles server: code is DONE and wired (`src/channels/imessage.js`
      outbound, `imessage-inbound.js` inbound, `transportFor` routes `channel:"imessage"`,
      `IMESSAGE` config block), currently DISABLED pending the server. Go-live is now a
      HARDWARE item: stand up BlueBubbles on a home Mac and set `IMESSAGE_SERVER_URL` +
      `IMESSAGE_PASSWORD` (see the Mac-fleet provisioning item in the topology section).
      Email remains the reliable text-out channel in the interim.
- [ ] **Media gap (deferred → tracked as workstream I):** the gate enqueues text
      only. MMS images, vCards, and forwarded-voicemail audio are dropped when
      COS_ENQUEUE is on (no media field in the payload). The front-door half of the
      MMS work lives here; see **workstream I (Multimodal / MMS intake)** for the
      full cross-repo plan and rationale.
- [x] **Inbound-email reconciler — LIVE 2026-06-27 (freyfam-assistant PR #2).**
      GOTCHA: email reaches the daemon via the `email-handler` webhook, which fires on
      Graph CHANGE NOTIFICATIONS — and those are **best-effort**. A dropped notification
      (or a mark-read race that trips the handler's `isRead` "already processed" skip)
      leaves an email in the inbox that is NEVER enqueued — silently lost. Observed live:
      a forwarded email sat read-but-unprocessed, queue empty, config all correct.
      FIX: `src/functions/email-reconciler.js` — a 5-min timer scans recent inbox mail and
      enqueues anything the webhook missed, deduped via a shared seen-store
      (`src/cos-inbound-seen.js`, Table `cosinboundseen`) the webhook now also writes on
      enqueue (the daemon dedups on QUEUE-id, not email-id, so double-enqueue would
      double-process). 2-min floor = never races the webhook; checkpoint = clean first-run
      baseline (no backfill). Verified: deployed, function registered, baseline checkpoint
      written on first tick. So inbound email is now self-healing against missed notifications.
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

### E. Real memory  `[x]`  — semantic recall LIVE 2026-06-20 (local embeddings)

Owns: `src/memory.js`, `src/decisions.js`, new `data/` seed scripts. Interface
(`recall`/`remember`) stayed stable so callers didn't change.

- DECISION (2026-06-18): embeddings deferred. **REVERSED 2026-06-20** — Nic chose
  LOCAL embeddings (privacy/local-first) over the Voyage API. Built this session.
- [x] **Replace `embedHash()` with real embeddings (2026-06-20).** `src/embeddings.js`:
      on-device sentence-transformer via transformers.js (`Xenova/all-MiniLM-L6-v2`,
      384-dim), lazy-loaded, ~90MB model cached at `data/models` (gitignored). No API
      key, no per-call cost, family text never leaves the Mac. `EMBEDDINGS_PROVIDER`
      (`local`|`none`); degrades to null on load failure. `recall()` is now HYBRID:
      `0.6*semantic + 0.4*lexical`, falling back to pure TF-IDF when off or for items
      embedded by a different/older model (`embModel` tag). `data/reembed.mjs`
      (`npm run reembed`) upgraded all 45 existing facts. Suite runs `EMBEDDINGS_
      PROVIDER=none` to stay offline. Verified: "where does Nic work" -> work-email
      fact @ 0.61; query/work-email 0.75 vs query/oat-milk 0.01. `test/embeddings.test.js`.
- [ ] (still deferred, not needed yet) Swap JSON store for sqlite-vec/LanceDB — the
      in-memory cosine scan is fine at household corpus size; revisit when it grows.
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
- [~] Live marketplace fetchers for the resale sites — BUILT 2026-06-26
      (`src/marketplaces.js` `runMarketplaceFeeds`, wired into `maybeRunResale`; reads
      each saved search across its sites via the LOCAL browser, surfaces NEW listings).
      eBay selectors trusted; Poshmark/Vestiaire/1stDibs selectors are best-effort and
      need a live capture pass on the Mac. Go-live = signed-in Chrome profile (same as
      First Look). TheRealReal excluded (First Look owns it).
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

#### Alexa → grocery close-the-loop (the fridge list → Friday order)

Intent: items the family adds at the fridge (Alexa) flow into the Friday Ralphs order,
resolved to the EXACT products they buy via order history. Costco same idea (later).
- **What already existed:** the private "Frey" Alexa skill (front-door
  `alexa-skill.js`) writes voice-added items into M365 To Do lists `Ralphs`/`Costco`/
  `Amazon Shopping List`; the front-door legacy grocery-order read those lists.
- [x] **Phase 1 — Lloyd/Chef read the To Do lists (2026-06-24).** `graph.js`
      `listTodoTasks`/`completeTodoTask` (app-only, Tasks permission verified on the
      COS app); `grocery.js` `mergeGroceryItems`/`gatherGroceryItems` union the local
      shopping list + the To Do `Ralphs` list (deduped); the Friday assembly now
      sources from both; `read_store_list` chief tool reads a store list on demand.
      266 tests green.
- **Input decision (RESOLVED 2026-06-24):** native-list → IFTTT is DEAD — Amazon cut
      third-party read access to the Alexa Shopping List (~2021), so IFTTT/Make no
      longer have an "item added to your Alexa list" trigger. Going with per-store
      PRIVATE Alexa skills instead, store = invocation name.
  - [x] **Option B — Lloyd writes to the lists (DONE 2026-06-24, live on next restart).**
        `graph.js addTodoTask` + `add_to_store_list` chief tool: "add milk to the Ralphs
        list" from any channel. The reliable, Alexa-independent input path. Verified live.
  - [x] **Backend skill routing (DONE 2026-06-24, front door, committed not deployed).**
        `alexa-skill.js` routes by calling skill: `Ralph`->Ralphs, `Costco`->Costco,
        general (`ALEXA_SKILL_ID`)->Amazon. Per-store intents still work (back-compat).
  - [ ] **FOLLOW-UP (Nic + deploy): stand up the per-store skills.** In the Alexa dev
        console create two PRIVATE skills (keep in Development — that's how "Costco" is
        allowed as an invocation): invocation `ralph` and `costco`, each with an
        `AddItemIntent` ({item}=AMAZON.SearchQuery, "add {item} to the shopping list"),
        endpoint = the Function `/api/alexa-skill`. The existing "Frey" skill stays as
        the general->Amazon one. Then set app settings `ALEXA_SKILL_ID_RALPHS` /
        `ALEXA_SKILL_ID_COSTCO`, push the front door (CI deploy), and verify
        ("ask Ralph to add milk to the shopping list" -> lands in the Ralphs To Do list).
- [~] **Phase 2 — bounce against order history (matcher DONE 2026-06-24; fetch
      pending live capture).** `src/grocery-match.js` resolves a free-text item to the
      exact product via token-coverage scoring against purchase history (phrase bonus;
      ties broken by frequency/recency; true ties flagged ambiguous; below threshold =>
      free-text fallback). `grocery.js resolveGroceryOrder` wires it into the Friday
      assembly + the approval prompt shows "oat milk -> Simple Truth Organic Oat Milk".
      Fully unit-tested. REMAINING: `readPurchaseHistory` reads the Ralphs "Buy It
      Again" page via the signed-in browser — URL + tile selectors are best-guess and
      need ONE live capture session (like the checkout flow); until then it returns []
      and the order behaves like Phase 1 (free-text), never a wrong product. After a
      placed order, mark the To Do items completed (`completeTodoTask`) to clear them.
- [ ] **Phase 3 — Costco.** Read the Costco To Do list + match against Costco purchase
      history + Costco ordering. Biggest lift (no Costco automation yet; warehouse buys
      aren't always in the online history). Deferred.

#### Household features (built 2026-06-24, on main; live on next daemon restart)

Net-new capabilities from the "what else" pass. Pure cores unit-tested (285 green).
- [x] **Meal-plan -> grocery list.** Meals carry `ingredients` (meals.js); `meal-grocery.js`
      `mealsToGroceryItems` collects+dedups; chief tool `meals_to_grocery_list` pushes them
      onto a store To Do list (reuses `addTodoTask`). Carmine should include ingredients
      when planning a meal for this to fill.
- [x] **Daily dashboard.** `src/dashboard.js` `formatDashboard` + chief tool `show_today`
      — a fast, deterministic "today" card (schedule/Fox/meals/tasks/packages), no model tokens.
- [x] **Finance recurring radar.** `finance.js` `detectRecurring`/`formatRecurring` flags
      weekly/monthly/yearly subscriptions, next-due + price changes; folded into the finance
      specialist's `analyze_transactions`. Surfacing only (no money movement).
- [x] **Action audit log.** `src/audit.js` logAction/listActions/formatAudit; the outbound
      action handlers (email/calendar/order/grocery) log; chief tool `recent_actions`
      ("what did you do this week?"). The paper trail for an agent that acts for the family.
- [x] **Use-it-up.** `meals.js` `useItUpSuggestion` gives Carmine a ready nudge to plan a
      meal around soonest-expiring items; folded into the chef `expiring_soon` tool.

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

### I. Multimodal / MMS intake  `[x]`  — daemon multimodal DONE; remote CHEF Function REDEPLOYED 2026-06-29 (Carmine now gets forwarded images; function verified responding). MMS-over-Twilio retired, so photos now arrive via Slack/email/iMessage. Only the natural end-to-end check remains: the next real photo delegated to Carmine.

Promoted from a buried bullet under B so it stays visible. Today the front door
enqueues **text only**; inbound MMS images, vCards, and forwarded-voicemail audio
are silently dropped (no media field in the queue contract). This is the path to
photo intake, which the current roster actually wants:
- **Shey (reseller):** snap a photo of an item → catalog / draft a listing.
- **Carmine (chef):** photo of groceries or a receipt → update food inventory.
(This replaces the old "Sylvie" framing in the Genet gaps below.)

Owns (cross-repo): the queue *contract* + `~/freyfam-assistant` front door + this
repo's `queue.js`/`orchestrator.js`.

- [x] **Queue contract pinned (2026-06-19):** `media?: [{url, contentType}]` (Twilio
      `MediaUrlN` + `MediaContentTypeN`). Payload is schemaless JSON so it flows through
      `queue.js` untouched; documented in the `queue.js` header.
- [x] **Daemon: fetch media + build Claude image blocks (2026-06-19).** `src/media.js`
      `fetchInboundMedia()` (Twilio basic-auth, Claude-supported image types only, caps
      count/size, skips audio/vCard/oversize non-fatally). `orchestrator.handleInbound`
      builds multimodal `content` (caption + image blocks) when `msg.media` is present;
      `runChief(body, model, {content})`. **Verified end-to-end**: real PNG →
      `fetchInboundMedia` → `complete()` vision answered correctly. `test/media.test.js`
      (5 tests) + suite 54/54.
- [x] **Routing (2026-06-19):** triage gets an `[N photo(s) attached]` hint; the chief
      persona now instructs Lloyd to read the photo and `delegate` to **resale** (Shey,
      items) or **chef** (Carmine, groceries/receipts). NOTE: `delegate` still passes
      TEXT only, so Lloyd describes what he sees to the specialist. Passing the image
      THROUGH to a specialist would extend the delegate seam (Function handler + runner
      + local-server) — a clean follow-up if specialists need the raw pixels.
- [x] **Hard constraints kept:** specialists return text; all outbound still goes through
      Lloyd's confirmation gate + `guards.js`. Media intake adds no outbound path.
- [x] **Front door (B repo, `~/freyfam-assistant`) — DONE 2026-06-19** (branch
      `cos-front-door`, commit `4d41630`): `mediaFromForm(formData)` maps Twilio
      `MediaUrlN`/`MediaContentTypeN` → `media:[{url,contentType}]` and the COS_ENQUEUE
      gate includes it. Forwards raw Twilio URLs (daemon fetches with its own auth).
      `test/cos-queue.test.js` 146 pass. **Pending merge→CI deploy** (like B's cutover).
- [x] **Specialists see the photo too — DONE 2026-06-19** (`workstream-i-mms`, `f17c182`):
      the inbound turn's image blocks ride along with `delegate` (tool schema stays
      `{agent, task}`; images come from context) → `runSpecialist(agent, task, {images})`
      builds multimodal content. Function handler + local-server parse `images`.
      Verified image rides delegate → server → runner. So Shey/Carmine get the actual
      picture, not just Lloyd's description.
- **TO GO LIVE:** (1) merge `workstream-i-mms` → main; (2) **redeploy resale + chef
      Functions** with the new runner (else they ignore forwarded images); (3) restart
      the daemon (Lloyd-side intake + forwarding); (4) merge + CI-deploy the front door.
- Parallel-safe: yes — contract pinned; front-door deploy lands independently.

### J. Cost watchdog  `[x]`  — LIVE + verified 2026-06-21 (both meters read real spend)

Built 2026-06-19. Hourly, zero-model-token reads of month-to-date spend → SMS to
`OWNER_PHONE` (via the guarded Twilio path) when a billing cycle crosses
`COST_ALERT_USD` (default $100), re-alerting every `+COST_ALERT_STEP_USD` ($50) as
it climbs. De-duped per tier per cycle in `data/cost-alerts.json`. Both meters
no-op until their creds are set, so this is safe to ship dark.

Owns: `src/cost.js`, `src/heartbeat.js` (throttled call), `config.js` (`COST`),
`src/search.js` (Brave query metering), `deploy/azure-budget.sh`, `test/cost.test.js`.

- [x] `src/cost.js`: Anthropic Admin `cost_report` + Azure Cost Management `query`
      readers, tier/cycle logic, local de-dupe state. Wired into the heartbeat on
      its own hourly cadence (`COST_CHECK_INTERVAL_MS`). Tests green.
- [x] `deploy/azure-budget.sh`: independent Azure-side budget backstop (action
      group + SMS at 80% / 100% / forecasted) that fires even when the Mac is off.
- [x] **Brave Search overage meter (2026-06-21).** Brave has no billing API, so
      `search.js` calls `recordBraveQuery()` on each successful search to count
      queries per cycle in `data/brave-usage.json`; `braveMonthToDateUsd()` bills
      anything above `BRAVE_INCLUDED_QUERIES` at `BRAVE_OVERAGE_USD_PER_1K` per 1k.
      Third meter in `SOURCES`, same $100 tiered alert. Off until the rate is set.
      Caveat: counts only queries through THIS daemon — a key shared with other
      apps undercounts. `braveOverageUsd` math unit-tested. Suite green.
- [x] **Brave plan numbers set (2026-06-23)** — `BRAVE_INCLUDED_QUERIES` +
      `BRAVE_OVERAGE_USD_PER_1K` configured to match the plan, so the third meter is on.
- [x] **Creds provisioned + verified LIVE 2026-06-21.** `ANTHROPIC_ADMIN_KEY` set;
      the Graph SP was granted **Cost Management Reader** on the subscription
      (`az role assignment create --assignee <sp> --role "Cost Management Reader"
      --scope /subscriptions/<id>`), clearing the prior 403. Live read: Azure MTD
      $13.65, Anthropic MTD $29.90 (both tier 0, no alert — correct). The integrated
      `checkCostThresholds` runs clean and degrades gracefully on a transient Azure
      429 (logs + skips that sample, no crash/false-alert; hourly cadence stays well
      within Cost Management's rate limit).
- [x] **Read → alert path confirmed (2026-06-23).** Workstream marked DONE. The alert
      rides `notifyOwner` (the owner messaging channel); with Twilio SMS closed it will
      deliver over iMessage once that server is up, and over email in the interim. The
      meters + tier/cycle logic are verified live (2026-06-21), so the watchdog is
      operational; only the owner-channel transport tracks the iMessage hardware item.
- [ ] **LATER (optional) — run the Azure budget backstop:** `bash deploy/azure-budget.sh`
      (needs write RBAC, more than the read-only SP). Also set an Anthropic Console
      monthly spend limit (Settings → Limits) as the hard-cap the daemon can't enforce.
- Parallel-safe: yes — isolated except a one-line heartbeat call. Independent of all
  other workstreams; only shares `.env` and `config.js` with the rest.

### K. Slack Socket Mode — the "desk" channel  `[x]`  — LIVE 2026-06-23 (socket connected in prod)

**Principle: port the method, not the hardware.** Genet's Mac Minis exist to
partition agents that run as separate processes and talk over Slack. We get the
three things that actually make that work — **channels as the interface**, the
**chief delegating where you can watch**, and the **channel boundary doubling as a
permission boundary** — without buying machines. Software partitioning (allowlists +
`guards.js` + `confirm.js` + not handing every persona every credential) replaces
physical partitioning.

**Why Socket Mode:** the Mac opens an OUTBOUND websocket to Slack and receives
events with no public endpoint — the same pull-only property we already chose for
SMS via the Azure queue. Both human channels stay pull-only; the home machine is
never publicly reachable. (App-level `xapp-` token with `connections:write` + a bot
token.)

**Hybrid split:** SMS over the Azure queue stays the remote, terse, approval
channel; Slack over Socket Mode becomes the desk channel — rich, organized by agent,
observable. Both feed the SAME orchestrator, brain, guards, and confirm gate.

**Channel topology (map to the current 6-agent roster):**
- `#cos` / DM with the bot = 1:1 with Lloyd (chief). Primary surface.
- `#finance #dev #resale #chef #security` = posting forces that persona — the channel
  just sets which agent the inbound routes to. (Per-agent channels, all six.)
- `#command` = observability win: you direct Lloyd here and the daemon mirrors every
  delegation into it ("Lloyd → Patrick: reconcile October card") plus the result.
- `#all-agents` = optional full-transcript "cooking" mirror.

**Scaffold changes (the one real refactor + hooks):**
1. [x] `src/channels/slack.js` via `@slack/bolt` Socket Mode (lazy optional dep,
       no-op until tokens set). Channel→agent map, DM/#cos→chief, per-agent channels
       force a specialist, posts replies. **Hard constraint kept:** the reply path
       calls `assertOutboundAllowed`. Started (non-fatal) from `daemon.js`.
2. [x] **Transport refactor (the keystone):** `handleInbound` now takes a transport
       `{reply, mirror}`; SMS/email built-in (mirror no-op), Slack passes its own.
       `transportFor` + `wrapDelegateWithMirror` exported + unit-tested. Done in
       commit `802e9f3`. I and L hang off this too.
3. [x] `onDelegate` → `mirror()` into `#command` on each delegate call + result
       (via `wrapDelegateWithMirror`). Works for in-process OR remote specialists.
4. [x] **Per-agent tool allowlist (Finn's lockdown) — DONE 2026-06-23.** The
       `REGISTRY` in `src/agents/tools.js` builds each specialist's tool defs/handlers;
       now an explicit `AGENT_ALLOWLIST` (per-agent permitted tool names) is the
       enforced boundary. `specialistTools()` FILTERS the registry's output down to the
       allowlist (fails CLOSED + logs on drift) and THROWS if an allowlist ever names a
       `CHIEF_ONLY_TOOLS` entry (outbound/high-stakes: send_email, place_order,
       create_calendar_event, delegate, ...), making hard-constraint #2 executable. A
       channel can't widen an agent: per-agent channels route via `delegate ->
       runSpecialist` (the scoped path), and the runner only ever assembles tools through
       `specialistTools()`. finance has no search/outbound by allowlist, not just by
       omission. Tests in `test/tools.test.js` (subset-of-allowlist, 1:1 tools<->handlers,
       no chief-only leak, finance lockdown, throw-on-misconfig). 234/234 green.
       (Note: Steve's Claude-Code backend path is a deliberately separate trust model
       with real file/bash tools — workstream Q — not governed by this in-process allowlist.)
5. [x] Confirmation upgrade: Slack Block Kit Approve/Deny buttons; `confirm.js` gained
       `registerApprovalNotifier` + `resolveByCode` so a button tap resolves the same
       pending code as SMS `YES <code>` (both paths live, no import cycle).
- [x] **LIVE 2026-06-23.** Tokens set, `@slack/bolt` installed; the daemon logs
      `slack socket mode connected { commandChannel: '#command' }` on every boot, so the
      desk channel is live in prod: DM/#cos -> chief, per-agent channels force a
      specialist via delegate, and `#command` mirrors delegations. Approve/Deny buttons
      resolve the same pending code as a YES reply.

**Flag (local-first tension):** Slack routes household conversation through Slack's
cloud — a privacy trade vs the local brain. Worth a conscious decision; SMS already
has the same property via Twilio, so it's consistent, not new.

- Parallel-safe: the transport refactor (#2) touches `handleInbound`/`orchestrator.js`
  (coordinate); `slack.js` is otherwise a new isolated file + the `@slack/bolt` dep.

### L. Document intake (PDF / .ics / .vcf) over email  `[x]`  — VERIFIED ON THE MINI 2026-06-29

**Verified on Lloyd's Mac mini 2026-06-29:** 34/34 document-intake unit tests pass
(`documents`, `collect-attachments`, `fetch-document`, `media`, `routing`), and the
REAL parsers (not the test mocks) run on the mini's `node@22` — `.ics` event parse,
`.vcf` contact parse, and `pdf-parse` via `createRequire` extracted 2,823 chars from
the repo's `ONESHEET.pdf`. This closes the one historically-fragile path (pdf-parse
silently no-op'ing); it now loads and extracts on the mini.

**Why email, not SMS:** MMS can't reliably carry PDFs/calendars (US carriers strip
non-image MMS); the Graph mailbox `cos@freyfam.com` carries attachments natively.
Sibling to **I** (now done — images over MMS → Claude vision): I = vision blocks from
MMS photos; L = extracted text/structured data from email attachments. Both extend
the same content-building step in `handleInbound` (see `media.js` for the pattern).
Slack file uploads (K) become a second doc channel later.

**Current gap:** the email front door folds subject+body to text and **drops
attachments**; `media.js` is images-only, and documents need parsing, not vision.

**Transport (recommended):** the daemon **fetches attachments via Graph**, reusing
the app-only `Mail.Read` it already has — no new creds, keeps the pull model.
- Front door passes `graphMessageId` on the email payload and does NOT delete the
  message (mark-read is fine).
- Daemon fetches `/users/{mailbox}/messages/{id}/attachments` and parses.
- Alt if message lifetime is a problem: front door → Blob + short-lived SAS URL
  (the storage account already has a Blob endpoint), mirroring how MMS uses Twilio
  media URLs. Do NOT inline bytes — Storage Queue messages cap at 64KB.

**`src/documents.js`** (parallel to `media.js`) — BUILT (commit `f10dd4a`):
- [x] `application/pdf` → text. NOW WORKING (2026-06-20): `pdf-parse@1.1.1` pinned +
      loaded via `createRequire` (the `import()` path silently threw on v1's debug
      block, so PDF intake was a no-op before). Cap `DOC_MAX_CHARS`; scanned PDFs out
      of scope v1. Verified on a real Bright Horizons curriculum PDF.
- [x] `text/calendar` (.ics) → event parse (summary/start/end/location/attendees),
      dependency-free. Feeds the **calendar/scheduling** gap (Genet's "Claire").
- [x] `text/vcard` / `text/x-vcard` (.vcf) → contact parse, dependency-free.
- [x] Unknown types → skip + log (non-fatal).

**Wiring & routing:**
- [x] `handleInbound` gathers MMS image blocks AND email doc text blocks through one
      path (`collectAttachments` + `extractDocuments`), augmenting triage text.
- [x] `graph.fetchAttachments(messageId)` pulls bytes via the granted `Mail.Read`.
- [x] **Cross-repo (front door):** DONE on `~/freyfam-assistant` branch
      `cos-front-door` (commit `cb486dc`) — email enqueue now passes `subject` +
      `graphMessageId`, message marked read but NOT deleted, contract test added
      (147/147). Also carries MMS `media` (commit `4d41630`, workstream I).
      **DEPLOYED 2026-06-20:** merged to `main` (`d0471fe`) + pushed → CI deploy
      triggered; `COS_ENQUEUE` already true. So email threading + subject + document
      intake + MMS images are now live end-to-end (confirm CI run succeeded in Azure).
      Inline `{attachments:[{name,contentType,contentBytes}]}` also supported.
- [x] Routing polish (2026-06-24): `src/routing.js` `routingHints(subject, body)` adds
      conservative advisory notes (receipt→finance, shipping→track, invite→schedule),
      folded into BOTH triage (model tier) and the chief's content (he picks the
      specialist). Never a hard route — the model still decides. Unit-tested.
- **Bright Horizons curriculum needs NO credentials (verified 2026-06-20).** The BH
      *email* media links (`mbdgw.brighthorizons.com/api/parent/medias/.../email`) are
      **public direct-fetch PDFs** — the long media id is the access token; HTTP 200,
      no login. (The parent *portal UI* is gated; the email links are not.) So the
      credentials/portal-scrape plan is MOOT for this path.
- [x] **Fox/BH ingestion chain complete (2026-06-20):** `fetch_document(url)` tool
      (`documents.fetchDocument`, http(s)-only + timeout + size cap) fetches a document
      LINK and routes it through `extractDocuments`. House rule: on a BH email, Lloyd
      `fetch_document`s the curriculum link → `set_fox_day` per day → the morning digest
      surfaces Fox's activities + wardrobe hint. Verified live on the real BH media URL
      (public PDF, 5pp). No credentials anywhere.
- [x] **Per-DAY curriculum (2026-06-20):** `src/fox-curriculum.js` parses the weekly
      grid per day by anchoring on each weekday name's x-position (robust to irregular
      column widths + gap-bridging items). `ingest_fox_curriculum(url)` tool fetches +
      parses + `set_fox_day` per day, with each day's date from the "Week of" anchor.
      Digest reads `fox_today` → shows today's activities + wardrobe hint. Verified
      live (Mon 6/15..Fri 6/19, per-day hints). `weekDates` unit-tested.

**Hard constraints (unchanged):** read-only parsing; outbound still via `confirm.js`
+ `guards.js`; no new Graph consent.

- [x] Tests `test/documents.test.js`: .ics/.vcf parse, unsupported-skip, PDF via
      injected parser, graceful no-parser skip. 68/68 suite green.
- Dep to install for PDFs in prod: a text extractor (e.g. `pdf-parse`); `.ics`/`.vcf`
  need none.
- Parallel-safe: `documents.js` + tests are isolated; the `handleInbound` hook + the
  `graphMessageId` contract overlap **I** and K's transport refactor — those three
  all touch `handleInbound`'s content-building, so do K's `reply()`/`mirror()`/content
  seam FIRST and hang I and L off it rather than racing the same function.

### M. Voice notes over iMessage (STT in / TTS out)  `[ ]`  — FUTURE SCOPE (not started); redefined 2026-06-25 for the iMessage-only world

Voice for the family, **asynchronous, over the iMessage channel — NOT phone calls.**
Twilio SMS was closed 2026-06-23 and Apple/iMessage has no PSTN bridge, so the old
plan (Twilio Programmable Voice / ConversationRelay answering real calls) is off the
table. Instead: the family sends an iMessage **voice memo**, Lloyd transcribes it and
runs the normal pipeline; he replies in text or as a synthesized voice note. This fits
the existing BlueBubbles intake and the pull-only posture — no public endpoint, no
telephony.

**Inbound (voice memo → text):**
- [ ] A voice memo arrives as an `audio/*` (m4a) attachment. Today
      `normalizeBlueBubbles` buckets non-images into `attachments` → `extractDocuments`
      → SKIPPED, so it is silently dropped. Add an audio branch: download the
      attachment, run **speech-to-text**, and feed the transcript into the EXISTING
      triage → `runChief` → specialist flow (treat it like a text message whose body is
      the transcript; tag it as a voice memo so Lloyd knows the source).

**Outbound (optional, text-or-voice reply):**
- [ ] `sendImessage` is text-only today (`POST /api/v1/message/text`). To reply IN
      voice, add a **text-to-speech** step and send the audio via BlueBubbles
      `POST /api/v1/message/attachment` (m4a). Default to a text reply; a voice reply is
      a nicety. Outbound stays a Lloyd capability behind the confirmation gate, same as
      every other send — a specialist never sends audio.

**STT/TTS provider (the one real new dependency):**
- [ ] Anthropic models do not do audio I/O, so this needs a separate STT (and, for
      voice replies, TTS) engine. PREFER LOCAL to keep the local-first/privacy posture:
      `whisper.cpp` for STT + a local/edge TTS, both on Lloyd's Mac so audio never
      leaves the house. A hosted STT/TTS is the easier-but-less-private fallback. Make
      it a lazy/optional dependency (like `@slack/bolt` / `playwright`) so the daemon
      runs fine without it.

**Constraints / notes:**
- Pull-only preserved: everything rides the local BlueBubbles webhook + send API; no
  public endpoint, unlike the old Twilio-Voice plan.
- Hard constraints unchanged: outbound (incl. a voice note) stays a Lloyd capability
  through `confirm.js`; specialists return text only.
- **Out of scope (parked — needs a telephony provider):** real phone calls to/from
  arbitrary numbers. FaceTime Audio is Apple-only and exposes no clean real-time audio
  hook for an agent, so it is at most a presence/relay nicety, not a voice assistant.
- Parallel-safe: inbound reuses the iMessage intake (`imessage-inbound.js`) + the
  queue/chief contract (transcript as `body`); outbound is an additive `imessage.js`
  helper. Sequence inbound first.

### N. Web search tool  `[x]`  — LIVE + verified 2026-06-22 (Brave key in)

A read-only `search` capability (query → ranked results) so Lloyd can "look up an
address / hours / a fact" and Shey can hunt listings. Distinct from `browse_page`,
which reads ONE known URL; search finds the URLs. Natural pairing: search → then
`browse_page` the best hit.

**Build once, grant via the per-agent allowlist** (this is the use case that makes
K#4's explicit allowlist worth finishing — it's how Shey gets search but Patrick
can't, regardless of channel):

| Persona | Search? | Why |
|---------|---------|-----|
| **Lloyd (chief)** | yes — primary | already owns `browse_page`; general lookups are the chief's job |
| **Shey (resale)** | yes — needs it most | resale hunting *is* search (listings, comps, prices); building block for the deferred marketplace fetchers |
| **Frank (security)** | yes, **scoped** | security/threat-intel lookups; prefer a curated source set over open web given Frank's tight posture |
| **Carmine (chef)** | on demand | recipes / store hours — grant when a real need shows |
| **Steve (dev)** | on demand | docs / SO lookups |
| **Patrick (finance)** | **NO** | finance stays locked down (read-only bank data, no external reach) — search widens exactly the surface "Finn's lockdown" guards |

**Scope:**
- [x] `src/search.js`: Brave-backed `webSearch()`; provider + key in `config.SEARCH`
      + `.env` (`SEARCH_PROVIDER`/`BRAVE_SEARCH_KEY`/`SEARCH_RESULT_COUNT`); degrades to
      a clear "search unavailable" when no key (Playwright pattern).
- [x] Exposed as the `search` tool. Granted via `REGISTRY` (`agents/tools.js`,
      shared `searchToolDef`/`searchHandler`) to **resale + security**, and on the
      **chief** in `orchestrator.js`. finance EXCLUDED by omission; chef/dev on demand.
- [x] Result shape `[{title, url, snippet}]`, capped at `SEARCH.count`. Pairs with
      `browse_page` (search finds the URL, browse reads it).
- [x] Tests `test/search.test.js`: result mapping + the allowlist (present for
      chief/resale/security, ABSENT for finance/chef/dev).
- [x] **LIVE 2026-06-22:** `BRAVE_SEARCH_KEY` set in `.env`; verified a real query
      ("La Canada Flintridge city hall address") returned ranked results through
      `webSearch`. Lloyd / Shey / Frank can now search.

**Constraints/notes:** read-only — no `confirm`/`guards` needed for the search call
itself; acting on a result (buy/email) still hits `confirm.js` + `guards.js`.
**Privacy:** query text leaves the network to the provider — same trade as
Twilio/Slack, so be deliberate about the provider. For remote specialists (Shey on
Azure) the tool runs in their env; transport-agnostic, no special handling.
- Parallel-safe: mostly — `search.js` is a new isolated file; granting it touches the
  `REGISTRY` (shared with F) and the chief tool list in `orchestrator.js`. Pairs with
  finishing K#4 (explicit allowlist).

### O. Persona depth + per-agent brains (the "soul")  `[~]`  — souls + rules DONE 2026-06-20; memory seeds need family data

The agents work, but their personas are thin and uneven (dev 86w, finance 105w,
resale 111w vs chef/security/chief ~290w) and read as role blurbs, not characters.
Genet's edge is that each agent has a real **soul** (e.g. Sylvie = "creative, bubbly
teacher") plus its own memory + decision log. This workstream gives each persona
depth and a genuine per-agent brain. Owns: `src/agents/*.md`, per-agent memory seeds,
the rules layer.

**Soul template (apply to all six, level them up):**
- [x] **Standardized all six `agents/*.md` (2026-06-20)** to: **Identity & voice** ·
      **Expertise** · **How I work / decide** · **Domain rules** · **Hard rules** ·
      **Style**. Thin ones (Steve/Patrick/Shey) got real character + judgment; chef +
      security gained Identity/voice + decision style; Lloyd got Identity/voice +
      How-I-decide. Hard rules preserved verbatim. Also fixed a STALE rule in Frank's
      persona (work-domain email is confirm-not-block since 2026-06-20; specialists have
      no outbound anyway). No fabricated family facts — personas point to recall_memory
      for tastes/allergies/etc. rather than asserting them.

**Per-agent brain (beyond the persona text):**
- [x] **Conversational path for the family to add memory + rules over time
      (2026-06-20).** Nic/Shelli no longer edit JSON + restart. Messaging Lloyd does it:
      `remember` takes an optional `agent` (seed a specialist's brain or shared);
      `add_rule`/`list_rules`/`remove_rule` manage standing rules (house or per-agent) in
      `house-rules.json` via `rules.js` `addRule`/`removeRule` (idempotent, index-or-text
      removal, agent validation, key-preserving). Rules re-read per turn → live on the
      next message, no restart. Hand-editing the JSON + `npm run seed` stays for bulk/
      power use. Chief persona instructs Lloyd to capture facts + always/never rules.
- [ ] **Bulk-seed each specialist's memory** with durable domain knowledge — NEEDS REAL
      FAMILY DATA from Nic (don't fabricate): Carmine → allergies/dislikes, equipment,
      go-to meals; Frank → home-security devices, network, alarm/camera setup; Shey →
      target brands/sizes; Patrick → accounts, budgets, recurring bills; Steve → the
      stack, repos, deploy targets. Either tell Lloyd as they come up (above) or add
      agent-scoped entries in `data/seed-notes.json` (`meta.agent`) then `npm run seed`.
- [ ] **Seed each local box's brain** when provisioning it. `data/brain.json` and
      `data/seed-family-domains.json` are gitignored (sensitive household data), so they
      do NOT arrive with `git clone`. Transfer the seed source out of band (AirDrop/scp/
      USB), then `npm run seed` + `node data/seed-family-identity.mjs` + `npm run seed
      data/seed-family-domains.json` (or copy a populated `brain.json` over). Per-box
      steps are in each `deploy/setup/*.md` (Lloyd §5 canonical; Frank §4b; Steve §3b).
- [x] **Per-agent domain rules (2026-06-20).** `src/rules.js` gained `getAgentRules`/
      `formatAgentRules` reading an optional `agentRules` map in the same
      `house-rules.json`; `runSpecialist` now injects a local-time line + the agent's
      standing rules (always-on, not recall lottery), mirroring `runChief`. Clock kept
      inline to avoid a delegate->runner->orchestrator circular import.
      `house-rules.example.json` documents the shape. The family fills in real per-agent
      rules (e.g. Carmine: "never plan nuts for Fox"). `test/rules.test.js`.
- [x] **Decision log per agent** — already live (`data/decisions/<agent>.md` + `.json`
      written via `log_decision`/`logDecision`). Refinement: make sure every specialist
      actually uses it, and surface a "what did you decide and why" review per agent.

**Constraints / cross-refs:** specialists still only RETURN text (hard rule); souls
don't grant new powers. The literal per-persona **voice** (TTS) is the audible side of
the soul — tracked in **M** (voice), tabled for now. Genet parity: our `agents/*.md`
= her `soul.md`; our `data/decisions/<agent>.md` = her `decision.md`.
- Parallel-safe: **yes, mostly per-agent** — each persona/seed is an independent file.
  The one shared touch is extending `runSpecialist` to inject per-agent rules (small,
  in `src/specialists/runner.js`). Do that once, then personas/seeds fan out cleanly.

### P. Morning digest (ported, Lloyd-composed)  `[x]`  — LIVE 2026-06-20

Daily morning digest, ported from the legacy assistant's 7am timer. Under the split,
Lloyd COMPOSES it by delegating (`src/digest.js` runs `runChief` with a brief; the
agent loop calls `list_calendar`, `fox_today`, and delegates to chef/finance/security/
resale). Fires once per local day in a morning window (`shouldRunDigest`) via the
heartbeat.
- [x] Delivered over BOTH channels: owner SMS + family email (`DIGEST_EMAIL_TO`),
      independent via `Promise.allSettled` so a blocked channel (Twilio) can't stop
      the other. Email is the reliable path until the number clears.
- [x] **Fox at Bright Horizons + wardrobe hint** (`src/fox.js`): reads the same
      `foxDailyContext` table the legacy used; `deriveClothingHint` flags paint/messy
      → old clothes, water → full change + towel. `fox_today`/`set_fox_day` tools; a
      house rule files each Bright Horizons email via `set_fox_day` so it stays fresh.
- [x] **Legacy timer gated + DEPLOYED** (`~/freyfam-assistant` `main` `37f4075`): the
      old morning-digest skips when `COS_ENQUEUE` is on, so no double digest.
- Freshness note: today's Fox row is empty until the next Bright Horizons email is
  filed; the digest just skips Fox's section until then. 95/95 daemon tests pass.

### Q. Steve's dev backend — API-only  `[x]`  — REVERSED 2026-06-25 (ToS): the Claude Code subscription backend was REMOVED; Steve runs on the metered API.

> **REVERSED 2026-06-25 (ToS).** Driving a Claude Code subscription headlessly from an
> automated agent violates Anthropic's terms, so the subscription backend was removed
> (PR #10): deleted `src/specialists/dev-claude-code.js` + its test, the `runner.js`
> branch + import, and the `DEV` config block. **Steve now runs on the metered API**
> like every other specialist, and keeps cost low by triaging by size — small, scoped
> tweaks he handles directly and returns as a proposal; large/open-ended work he routes
> to a **human-driven remote Claude Code session** with a crisp brief; he coordinates the
> dev backlog (his + Nic's) via `propose_change`/`list_proposals`. See persona
> `src/agents/dev.md`, onboarding `docs/STEVE_HANDOFF.md`, and setup
> `deploy/setup/steve-macbook.md` (all API-only, PR #10/#11). **The build log below is
> HISTORICAL** — that backend no longer exists.

Run **Steve (dev)** on a **Claude Code / Claude Max subscription** instead of the
metered Anthropic API. Two reasons it's the right agent for this: dev work (file
edits, running tests, building apps — Genet's Cole built a kids' TV app) is exactly
Claude Code's wheelhouse, and flat-rate subscription billing takes the heaviest
agent off per-token API cost. Fits the topology: Steve already runs locally on the
old MacBook, where Claude Code runs.

**How (verified via the claude-api skill):** Claude Code, the `ant` CLI, and the
Claude Agent SDK all resolve a **subscription via OAuth profile** (`claude` `/login`
or `ant auth login`) — no API key. So Steve's local server (`COS_AGENT=dev`) invokes
Claude Code (headless `claude -p` or the Agent SDK) for the task instead of the
`claude.js` → API path. The `delegate` contract `{agent,task} -> text` stays stable;
only Steve's execution backend changes.

- [x] **Route the `dev` runner to a Claude-Code backend (2026-06-21).**
      `src/specialists/dev-claude-code.js`: `runDevViaClaudeCode()` shells out to
      headless `claude -p <task> --output-format json --append-system-prompt <persona+ctx>`
      and returns the `result` text. Steve's persona, local-time line, standing rules
      and recalled memory all ride along, so he's still Steve — now with Claude Code's
      real file/bash/build tools. `runner.js` branches to it when
      `agent==="dev" && DEV.backend==="claude-code"` (config block `DEV`,
      `COS_DEV_BACKEND`). Contract `{agent,task}->text` unchanged. Text-only path:
      photo turns fall back to the API loop. `runProcess` is injectable;
      `test/dev-claude-code.test.js` (9 tests) pins parse/scrub/cap/timeout. 134/134 green.
- [x] **Critical gotcha handled.** `subscriptionEnv()` DELETES both
      `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child env so the OAuth
      subscription wins precedence (test asserts the spawned child carries no key).
      `.env.example` warns to keep Steve's process env clean too.
- [x] **Usage-cap fallback built.** A cap throws `DevBackendError{code:"usage_limit"}`;
      with `COS_DEV_FALLBACK_API=true` (default) the runner logs and spills back to the
      metered API loop, so a capped subscription degrades to "still works, just metered"
      rather than erroring. Same for timeouts / nonzero exits.
- [x] **Backend VERIFIED LIVE on Nic's Mac (2026-06-22).** Merged to main
      (cherry-pick b9e926a). A real dev task via `delegate({agent:"dev"})` with
      `COS_DEV_BACKEND=claude-code` and fallback OFF returned "READY" in 2.1s through
      headless `claude` v2.1.81 — the child env had `ANTHROPIC_API_KEY` stripped, so it
      resolved via the subscription OAuth profile, not the metered API. Confirms the
      backend works end-to-end; only the per-machine login + ToS remain for Steve's Mac.
- [ ] **GO-LIVE (external, on Steve's Mac):** `claude /login` once (subscription
      OAuth profile — a credential step, not an `.env` key); ensure `ANTHROPIC_API_KEY`
      is NOT in that process's env; set `COS_DEV_BACKEND=claude-code`; run a real dev
      task through `delegate` and confirm it returns text without spending API tokens.
- [ ] ToS: confirm the subscription terms allow this automated household use.
- Note: this is a capability upgrade too — Claude Code gives Steve real file/bash/build
  tools (vs the current text-only runner), which is what "build a household app" needs.

### R. Resilience & disaster recovery (local hardware failure / power outage)  `[x]`  — software done 2026-06-24; hardware (auto-power-on + UPS) confirmed 2026-06-29; only OPTIONAL cold-standby failover remains

The system is local-first, so the Mac mini running Lloyd is a single point of failure:
a power outage or hardware/disk failure takes down the host that owns the queue
consumer, the confirmation gate, ALL outbound channels, the heartbeat (digest /
reminders / resale runs / cost watchdog), and Lloyd's brain. This workstream makes
the household survive that. The architecture already has the key strength — **inbound
is buffered in the durable Azure queue while the Mac is dark** — but there are real
gaps in state durability, auto-recovery, and (most urgent) independent monitoring.

**What already protects us (don't rebuild):**
- Inbound SMS/email queue in Azure Storage (durable) and the Mac PULLS — messages
  wait safely while the Mac is off; the daemon drains them on restart. (workstream A/B)
- launchd `RunAtLoad` + `KeepAlive` → the daemon auto-starts on boot and auto-restarts
  on crash. (workstream H)
- Dead-letter (poison) queue stops one bad message from starving the consumer. (H)
- On-disk persisted state reloads across restarts: pending-approvals, digest-state,
  tasks, reminders, etc. — a *power* blip loses nothing (a *disk* failure does — below).
- Azure specialists (finance/resale/chef) are cloud scale-to-zero → unaffected by a
  local outage. Only Lloyd + the local Macs (Frank/Steve) go dark.

**Gaps to close (roughly priority order):**
- [x] **Independent off-Mac liveness monitor (dead-man's-switch) — LIVE 2026-06-24.**
      Daemon side: `src/liveness.js` upserts a {lastSeen,host,pid} row to the
      `cosliveness` Table every heartbeat tick + on boot (verified the row lands).
      Monitor side: front-door `src/functions/liveness-monitor.js` — a 15-min Azure
      timer (DEPLOYED + registered; CI run 28122166274 success) reads that row and, if
      Lloyd hasn't checked in within ~45 min, emails the family via `notifyFamily`
      (email — the working channel; Twilio is dead); de-dupes (one alert + 6h re-alerts)
      and sends a "back online" note on recovery. Tunables: `LIVENESS_STALE_MINUTES`,
      `LIVENESS_REALERT_MINUTES`, `LIVENESS_ALERT_TARGET` (default both). Zero Claude
      tokens, sub-cent Azure. VERIFIED END-TO-END 2026-06-24: forced a stale condition
      (`LIVENESS_STALE_MINUTES=1`, target scoped to nic), manually triggered the timer,
      and the alert email "Home assistant may be down" landed in the owner's inbox; then
      reverted the test settings + reset the alert state. The dead-man's-switch fires.
- [x] **Extend the inbound queue message TTL — LIVE 2026-06-24.** Front door
      `cos-queue.js` sets `messageTimeToLive` on enqueue via `INBOUND_MESSAGE_TTL_SECONDS`
      (default 28 days; -1 = never expire), up from Azure's 7-day default, so a multi-day
      local outage loses no inbound. DEPLOYED (same CI run). Applies to new enqueues.
- [x] **State durability / off-site backup (disk-failure protection) — DONE 2026-06-24
      (option a).** `src/backup.js` snapshots all `data/*.json` (incl. the 1.6MB
      brain.json + per-agent decision logs) to Azure Blob (`cos-state-backup/latest/`)
      on a slow cadence (default 6h, wired into the heartbeat via `maybeBackup`),
      excluding the regenerable 87MB model cache. Blob not Table because brain.json
      exceeds Table's 64KB/property + 1MB/entity limits. Best-effort (never throws).
      Restore after a disk loss: `npm run restore` (data/restore-backup.mjs) pulls the
      latest snapshot back into data/. VERIFIED: live backup wrote 23 files (2.0MB),
      model cache excluded, dry-run restore lists them. `selectBackupFiles` unit-tested.
      (Deferred option b — migrating Lloyd's stores onto the MI Table backend — remains
      the eventual durable end state; the Blob snapshot is the quick, complete win.)
      DEPLOY NOTE: takes effect on the next daemon restart (the running process predates
      backup.js); held off here because a parallel session had the working tree.
- [x] **Dedicated main-only daemon checkout + main-safe nightly restart — SCHEDULED
      cutover 2026-06-26 01:05.** The single working dir was being branch-switched
      between parallel sessions, so a restart could deploy a feature branch's in-progress
      code instead of merged `main`. Fix: the live daemon moves to its OWN checkout
      `/Users/nfrey2/cos-live` that only ever tracks `main` (carries `data/` state; dev
      happens in the separate dir / git worktrees, so branch churn never reaches the
      daemon). A main-safe **nightly 4am restart** (`com.freyfam.cos.restart` ->
      `cos-ops/restart-from-main.sh`: `git reset --hard origin/main` + `npm install` +
      kickstart) replaces the old plain-kickstart job, so the automated restart is always
      from `main`. The cutover runs unattended at 01:05 (copies state, repoints launchd,
      auto-rolls-back to the old dir if the daemon doesn't come up). See
      `deploy/setup/restart.md` (PR #9) + the always-restart-from-main memory. Verify:
      `tail /Users/nfrey2/cos-ops/cutover.log`; `pgrep -fl cos-live/src/daemon.js`.
- [x] **Auto-power-on after an outage — CONFIRMED ON 2026-06-29 (Nic).** Macs are set to
      power on automatically when power returns (`pmset autorestart` / firmware "start up
      after power failure"), so launchd's RunAtLoad brings the daemon back unattended.
- [x] **UPS + graceful shutdown — CONFIRMED 2026-06-29 (Nic).** The Macs are plugged into
      a UPS, so short outages are ridden out and a long one can trigger a clean shutdown
      (avoids mid-write corruption of the JSON state).
- [x] **Outage-aware restart behavior — DONE 2026-06-24.** `src/outage.js`: the
      heartbeat stamps a local last-seen each tick; on the first tick after (re)start,
      if the gap exceeds ~30 min (`OUTAGE_THRESHOLD_MS`) Lloyd notifies the owner he was
      offline from X to Y and is catching up — a silent multi-hour gap becomes visible.
      VERIFIED by tests: drain the queue (already does), past-due reminders fire on the
      catch-up tick (`getDueReminders` returns fireAt<=now — confirmed), digest/grocery
      window guards already prevent stale/late sends. `assessGap`/`formatDuration` +
      boot-check unit-tested. Deploys on the next daemon restart.
- [ ] **(Heavier, optional) Cold-standby failover.** Once state lives in durable storage
      (gap 3b), a second Mac with the same `.env`/creds can assume Lloyd's role. Guard
      with a single-active lease (a Blob/Table lock) so two daemons don't both run the
      heartbeat and double-fire proactive work; queue consumption itself is safe with
      competing consumers (each message goes to one). Only worth it if uptime matters
      more than the cost of a second always-on box.

**Constraints:** the hard constraints don't change — outbound + confirmation stay on
Lloyd wherever he runs; a standby is still one Lloyd at a time. Monitoring/heartbeat
writes to the cloud must not carry family content (just liveness signals).
- Parallel-safe: the monitor (Azure-side) + queue TTL (front-door repo) + backup timer
  are largely independent; the store migration (3b) overlaps E/`collection.js`.

---

### S. COO agents — one "first employee" per company  `[x]`  — BUILT + DEPLOYED DARK (2026-06-30); autonomous reviews gated on COO_REVIEW_ENABLED

**Build state (reconciled 2026-06-30).** Shipped as a stacked-PR chain, then
consolidated onto `main`:
- **Step 1 (PR #30):** roster `data/companies.json` + `src/companies.js` loader +
  COO/company-specialist persona templates + cost tiering (COOs Sonnet, company
  specialists Haiku). **On main.**
- **Step 2 (PR #31):** request seam `src/coo-requests.js` (`request_specialist` /
  `request_heavy_lift` / `request_action`) + the `{text, requests}` delegate/runSpecialist
  contract change. **On main.**
- **Step 3 (PR #32):** per-COO cost ledger `src/cost-ledger.js` (soft budget warn).
  **On main.**
- **Step 4 (PR #33):** autonomous per-COO review tick `src/coo-review.js` wired into
  `heartbeat.js`, ships dark (`COO_REVIEW.enabled`). **On main 2026-06-30** (cherry-picked;
  23/23 COO tests pass).
- **Step 5 (DONE 2026-06-30):** first real COO end-to-end — **Sasshey** is the
  reference. Added per-company `reviewEnabled` (in `companies.json` + normalized onto
  the COO roster entry; the heartbeat review loop skips any COO without it). Sasshey
  is `reviewEnabled: true`; the others stay dark. Seeded the `sasshey-coo` brain with
  grounding facts (`data/seed-coo-sasshey.mjs`, idempotent). The global
  `COO_REVIEW_ENABLED` master switch stays OFF, so nothing auto-runs until Nic flips
  it — then ONLY Sasshey reviews. Validated end-to-end on the mini (live review →
  plan + gated requests).
- **Step 6 (DONE 2026-06-30):** role-specific company-specialist tools. Data-driven
  by role slug (`agents/tools.js`): research / outward-facing roles (marketing, sales,
  supply chain, community intelligence, buyer-behavior, mfg-eng) get read-only web
  `search`; internal-data roles (inventory, orders) stay baseline until those backends
  exist. Never a CHIEF_ONLY tool (enforced by `specialistTools`). 444/444 tests pass.

PRs #30-33 are now superseded (their content is on `main`); close them. The original
design notes follow.

**Companion doc:** `ORG_STRUCTURE.md` (repo root) holds the business shape — the concrete
org chart, the company roster, the per-company specialist tier, the Azure resource-group
layout, and the cost-governance thresholds. This section is the engineering plan; that
doc is the org reference. The two were reconciled 2026-06-26 and should move together.

**Vision (Nic).** Build an agent for each company idea — the company's first employee,
a **COO**. Each COO manages its company end to end: project schedules, communication,
marketing, and development. COOs are managers, not doers of last resort: they **request
specialists through Lloyd** (e.g. ask for Steve when dev help or an extra push is
needed) and **request Nic to run heavy lifting on his Claude Code subscription** for
serious work. Each COO runs under its own **cost watchdog + budget**.

This is a NEW TIER above the household specialists. It does NOT change the hard
constraints — it is designed to inherit them by construction.

#### Where it fits the existing architecture

Three enforced layers exist today; COOs slot in as a fourth, *between* Lloyd and the
specialists in authority but *like a specialist* in containment:

| Layer | Holds outbound? | Role |
|---|---|---|
| **Lloyd** (chief) | YES — sole holder of `CHIEF_ONLY_TOOLS`, the confirmation gate | host + router + chokepoint (unchanged) |
| **COOs** (new) | **NO** | manage a company; surface plans + emit **requests**; never act directly |
| **Specialists** (finance/dev/resale/chef/security) | NO | scoped doers; surface, don't act (unchanged) |

A COO is shaped like a specialist — own persona, agent-scoped memory (`memory.js`),
decision log (`decisions.js`), standing rules (`rules.js`), and a **scoped tool
allowlist** (`AGENT_ALLOWLIST`) that **excludes every `CHIEF_ONLY_TOOLS` entry**
(`specialistTools()` already throws if an allowlist contains one). So a COO physically
cannot send mail, spend money, place orders, or delegate to a specialist on its own.
It produces text + structured **requests**; Lloyd fulfills them behind the gate.

#### Hard constraints preserved (by construction)

1. **Outbound + confirmation stay on Lloyd.** A COO has no channel and no
   `CHIEF_ONLY_TOOLS`; every real-world effect (a hire-a-specialist run, a marketing
   email, a spend) routes COO → Lloyd → `confirm.js`. Same chokepoint as today.
2. **Human-in-the-loop for high stakes.** "Heavy lifting on Nic's subscription" and any
   money/marketing send are confirmation-gated asks to Nic, never auto-run.
3. **No money movement.** A COO surfaces spend/marketing actions; Nic executes them.
4. **Isolation.** Per-COO memory/decision scope (one COO can't read another's), per-COO
   budget, and — phase 2 — per-COO API key/Table scope, mirroring the specialist model.

#### The request + escalation seam (the heart of it)

COOs can't call `delegate` (it's `CHIEF_ONLY`). Instead a COO emits requests that Lloyd
routes. Two invocation modes:

- **Delegated:** Lloyd hands a COO a management task; the COO returns its plan + a list
  of requests; Lloyd fulfills each (delegate to Steve, gated ask to Nic, etc.).
- **Autonomous tick:** on a schedule (heartbeat-style, per-COO cadence), Lloyd runs each
  COO's "review the company" pass; actionable output becomes gated requests — mirrors
  the existing heartbeat → triage → escalate pattern (`heartbeat.js`).

Request types (all flow through Lloyd's gate):
- `request_specialist` → Lloyd `delegate`s to the named specialist (e.g. **Steve for a
  dev push**). Routine help. Steve runs on the **metered API** (workstream Q was
  REVERSED on ToS grounds 2026-06-25 — no automated agent drives a Claude Code
  subscription; see Q).
- `request_heavy_lift` → a **confirmation-gated ask to Nic** to run a scoped task in a
  **human-driven Claude Code session** — Nic, a person, at his own keyboard. This is NOT
  an automated agent on the subscription (that path was removed; `dev-claude-code.js` /
  `DEV` no longer exist). It mirrors Steve's own reversed pattern: small tweaks Steve
  returns as a proposal on the API; large/open-ended work routes to a human-driven remote
  Claude Code session with a crisp brief. Serious dev/build work, human-initiated.
- `request_action` → any outbound/spend (marketing email, tool signup) → `confirm.js`.

#### Cost watchdog — BOTH, phased (Nic's call 2026-06-25)

Today `cost.js` only meters **org-wide** month-to-date (`anthropicMonthToDateUsd`,
Azure, Brave). Per-COO budgets need attribution:

- **Phase 1 (now): local token ledger.** Tag every agent run with its COO key, thread
  it into `agentLoop`/`complete`, and record `resp.usage` (input/output/cache tokens)
  into a per-COO, per-cycle ledger (new `src/cost-ledger.js`, JSON like
  `cost-alerts.json`). Convert to $ via `MODELS` price table. Soft cap: warn Nic at a
  COO's budget threshold (reuse the watchdog alert path), optionally refuse further
  non-essential spend until the cycle resets. Approximate but works with zero new
  accounts.
- **Phase 2 (when a company gets real): per-COO Anthropic key/workspace.** A roster
  entry carries its own key; that COO's calls use it; the Admin `cost_report` attributes
  authoritative $ per key. Matches the future per-specialist Azure isolation model.
  Flip per COO as needed; the local ledger stays as the live early-warning layer.

**Concrete governance thresholds (CONFIRMED 2026-06-26, see `ORG_STRUCTURE.md`).** Finance
(the shared family cost watcher) auto-approves below these and escalates to Nic above them,
so routine work never loops him in:

| Scope | Threshold | Action |
|---|---|---|
| Per-request cost estimate | $10 | Escalate to Nic |
| Per-request token usage | 100,000 tokens (adjustable) | Escalate to Nic |
| Monthly budget per resource group | $80 | Budget + alert per rg (freyfam/sasshey/dariviant/pontable) |
| Monthly total subscription | $400 | Hard limit for the Freyfam subscription |

Two complementary layers: the local token ledger (phase 1) is the live per-COO early
warning; the Azure RG budgets are the authoritative monthly view finance reconciles
against. Azure budgets are notification-only by default — to make $400 a true hard stop,
wire the alert to an action group that throttles/stops resources at the limit. The two
escalation outcomes map onto the request seam: **approve agent execution** (finance
green-lights, orchestrator runs it, `request_specialist`-style) vs **hand to Nic**
(`request_heavy_lift`, Nic does the heavy lifting in his own session). Only Nic ever
touches the subscription account directly.

#### Data-driven roster (so "an agent per idea" is a config edit)

Today the roster is hardcoded (`KNOWN_AGENTS`, `AGENT_ALLOWLIST`, `REGISTRY`). Make COOs
**config-driven**: `data/companies.json` — each `{ key, company, budgetUsd, cycle,
allowedSpecialists:[...], specialists:[...], persona, apiKey? }`. A loader registers each
COO's persona + scoped allowlist + memory namespace + budget at boot, plus each company
specialist's persona/allowlist/namespace. Adding a company = add an entry + persona
files; no core code change.

**Holding + roster (CONFIRMED 2026-06-26, see `ORG_STRUCTURE.md`).** `freyfam`
(freyfam.com) is the holding shell — Lloyd and the family specialists live here and
service all companies. Three companies sit beneath it:

| Company | key | Business |
|---|---|---|
| **Sasshey** | `sasshey` | SaaS wardrobe-inventory tool + consignment marketplace; membership + brokering revenue |
| **Dariviant** | `dariviant` | Aftermarket parts for Rivian / EV pickups; funds a long-term range-extended R1T overland camper |
| **Pontable** | `pontable` | Recreational water sports; floating picnic table; B2C + B2B hospitality |

**Per-company specialists are real agent personas** (CONFIRMED 2026-06-26), not org-chart
placeholders. Each COO owns a tier of company-scoped specialists that hold the operational
data and feed it up (specialist → COO → Lloyd). They are shaped like family specialists
(own persona, scoped memory, NO `CHIEF_ONLY_TOOLS`) but namespaced to their company:
- **Sasshey:** inventory, marketing, buyer-behavior analyst, sales.
- **Dariviant:** supply chain (owns compliance/certification for now), inventory, orders,
  community intelligence (Rivian/Slate forums, Reddit), manufacturing engineering, sales,
  marketing.
- **Pontable:** supply chain, inventory, orders, sales, marketing, manufacturing engineering.

So the roster has **two scopes**: *family specialists* (shared, freyfam-level: finance,
Steve, resale, plus a shared manufacturing-engineering baseline) and *company specialists*
(namespaced under a COO). This widens `request_specialist`: a COO can request its OWN
company specialist directly, or — via Lloyd — a shared family specialist (e.g. Steve).

**Shared but splittable.** Company specialists inherit from family-level templates (e.g.
the inventory schema, the manufacturing-engineering standards). A change to a shared
template propagates to the company specialists that inherit it (Dariviant/Pontable
inventory, both mfg-eng roles). Architected so a company that takes off can be peeled out
into its own tooling/daemon later without breaking the rest.

#### COO capability surface (what it manages)

Schedule/project tracking (reuse `tasks.js`/`reminders.js`/calendar reads), comms drafts
(surface; Lloyd sends), marketing planning (surface; gated send), and dev planning
(propose; request Steve or heavy-lift). All read/plan/propose — never act.

#### Staged plan

- [ ] **0. This design doc** (done) — review the shape before any code.
- [ ] **1. Roster + persona template.** `data/companies.json` loader seeded with the three
      confirmed companies (sasshey/dariviant/pontable); `agents/coo.template.md` charter +
      a company-specialist persona template; register one COO's persona + a COO
      `AGENT_ALLOWLIST` (planning/read/request tools only, NO `CHIEF_ONLY_TOOLS`).
- [ ] **2. Request seam.** COO request tools → Lloyd router; `request_specialist` (→Steve,
      metered API), `request_heavy_lift` (→gated ask to Nic to run it in his own human-driven
      Claude Code session — NOT an agent on the subscription), `request_action` (→`confirm.js`).
- [ ] **3. Per-COO cost ledger (phase 1).** `cost-ledger.js`: tag `agentLoop` usage by
      agent, per-cycle accumulation, budget alert + soft cap. Tests.
- [ ] **4. Autonomous tick.** Per-COO scheduled review (heartbeat-style), escalate
      actionable output as gated requests.
- [ ] **5. First real COO** end-to-end as the reference impl.
- [ ] **6. Per-COO key (phase 2)** when a company warrants authoritative billing.

#### Open questions (decide before phase 1)

- COO ↔ Lloyd cadence: how often does an autonomous tick run, and what's the per-COO
  token budget per tick (bounds runaway spend)?
- ~~Where COOs run~~ (RESOLVED 2026-06-26, see `ORG_STRUCTURE.md`): one orchestrator runs
  all four personas (Lloyd + 3 COOs) in-process while early — shared context, lower cost.
  Architected to split into per-company daemons later (the topology already supports
  per-agent hosts via the `delegate` endpoint), so no debt now.
- Soft-cap policy: at budget, warn-only, or hard-pause non-essential COO spend until reset?
- Marketing/comms: how much can a COO DRAFT autonomously vs require a Nic prompt?

- Parallel-safe: mostly additive (new roster loader, new persona, new `cost-ledger.js`,
  new COO allowlist). The serial touch-point is `orchestrator.js` (request-router tools)
  and `agentLoop`/`complete` (usage tagging) — coordinate those edits. Builds directly on
  E (memory), F (specialist tools), J (cost watchdog), O (personas), and Q (Steve, now
  API-only — heavy lifting is a human-driven session, never an agent on the subscription).

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
- [ ] **Seed each local box's brain** when provisioning it. `data/brain.json` and
      `data/seed-family-domains.json` are gitignored (sensitive household data), so they
      do NOT arrive with `git clone`. Transfer the seed source out of band (AirDrop/scp/
      USB), then `npm run seed` + `node data/seed-family-identity.mjs` + `npm run seed
      data/seed-family-domains.json` (or copy a populated `brain.json` over). Steps are in
      each machine's setup doc (`deploy/setup/lloyd-mac-mini.md` §5 is canonical;
      `frank-mac-mini.md` §4b, `steve-macbook.md` §3b). Recall filters by agent, so each
      box only surfaces its own agent-scoped notes plus shared facts.

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
      - [x] `memory.js` — DONE 2026-06-24. Migrated onto the pluggable collection store
        (local brain.json by default, identical format; MI Azure Table when COS_TABLE_*
        is set). Durable memory for workstream R (survives disk loss natively) AND the
        remote-recall path for the Azure split. recall/remember unchanged; verified
        against the existing 1.6MB brain.
      - [x] `checking-balance.js` (finance) — DONE 2026-06-29. The last raw-file finance
        holdout, moved onto the collection store (partition `checkinganchor`, single
        `anchor` row) WITH backward-compat (reads the old `{amount,asOf}` file until the
        next set upgrades it), so the existing anchor survives the change. With this,
        ALL finance stores (financelog/obligation/creditstatement/categoryrule/
        financeinbox/checkinganchor) are Table-ready. **Remaining for remote Patrick
        (mini-side cutover, can't be done off-mini): push the live finance data into the
        finance MI Table, add a cold-start warm-up, then flip `COS_SPECIALIST_URL_FINANCE`
        on + restart.** Until then Patrick stays in-process (fully working).
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
- [ ] **Stand up the BlueBubbles iMessage server** (the primary text channel now that
      Twilio SMS is closed). Install BlueBubbles on a home Mac signed into the family
      iMessage account, enable the private-api send mode, then set `IMESSAGE_SERVER_URL`
      + `IMESSAGE_PASSWORD` in Lloyd's `.env` and restart. Code is done (workstream B);
      this is the hardware/login gate. Until then, owner alerts + replies go over email.
- [ ] Verify the read-only-domain guard + confirmation gate still gate every
      outbound path after the split (specialists return text only; runner carries no
      channel — invariant documented in `runner.js`)
- [ ] **Give the COS its own Azure Maps key (decided 2026-06-20, do later).** The
      `commute_time` tool currently shares the legacy assistant's `AZURE_MAPS_KEY`
      (carried into this repo's `.env`). Provision a dedicated Maps account for the
      COS and swap `AZURE_MAPS_KEY` so rotating/deleting the old resource doesn't
      take commute data down in both apps. Code needs no change — just the key.
- [x] **Move resale (Shey) back to Azure (remote). DONE 2026-06-30 — redeployed +
      verified.** Confirmed the stale-code theory live: the old Azure Function lacked
      the `run_saved_searches` tool, so heartbeat sweeps returned "I don't have that
      tool" text that notifyOwner emailed to Nic as a bogus "find." Fix done properly:
      installed `az` 2.87 + `func` 4.12.1 on Lloyd's mini (Homebrew; had to
      `brew trust azure/functions`), `az login` (sub "SassaShey Dev"), then
      `AGENTS=resale bash deploy/publish-specialists.sh` (source-only, remote Linux
      build) — "deployment was successful," host Running on current main (incl. commit
      902f0cd eBay-API/local-browser). Verified: a keyed `delegate({agent:"resale"})`
      asking it to run saved searches returned `NONE` correctly (HTTP 200, 4.8s) — tool
      present, no abort. `COS_SPECIALIST_URL_RESALE` uncommented, `COS_SPECIALIST_TIMEOUT_MS=60000`,
      daemon restarted; `chooseTransport` = remote for finance/resale/chef + Frank, local
      for dev. Function keys persist across deploys (existing `pTLk…` still valid; the
      script's key-fetch printed empty due to a perms gap, non-blocking).
      **finance + chef ALSO redeployed 2026-06-30** (Nic gave explicit OK after the
      classifier blocked the unscoped attempt): `AGENTS="finance chef" bash
      deploy/publish-specialists.sh` succeeded for both; verified keyed pong round-trips
      (finance 200/5.3s, chef 200/1.9s). All three Azure specialists now on current main.
      Also added model auto-update (`src/model-registry.js` + heartbeat weekly check):
      resolves newest model per tier from the live Models API and notifies on a new
      release (Opus stays the heavy family; Fable/Mythos excluded as premium).

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

- [x] **Calendar / scheduling** (Claire) — LIVE 2026-06-20. `graph.js`
      listEvents/createEvent + `list_calendar`/`create_calendar_event` tools (create
      confirm-gated). Applies the house rules (workday → work-email invitees; House
      Cleaning → showAs=free), enabled by the outbound policy change. **Consent gate
      cleared:** `Calendars.ReadWrite` was ALREADY admin-consented on the Graph app
      (the old assistant did calendar work; the daemon reuses the same app) — verified
      `listEvents` reads the cos@ calendar live. Builds on the **house-rules layer**
      (`src/rules.js`) + **outbound policy change**, both done 2026-06-20.
      Final live-verify (not blocking): a real `create_calendar_event` (sends invites).
- [ ] **Photo / multimodal intake** — now its own first-class **workstream I**
      (inbound MMS → image content blocks). Roster fit: Shey (item photos), Carmine
      (groceries/receipts). See workstream I for the cross-repo plan.
- [ ] **Image generation** (Sylvie) — a creative tool (Gemini or another provider).
      New tool module → wired in F.
- [x] **Printer access** (Sylvie) — DONE 2026-06-29. `src/channels/printer.js` drives
      local CUPS (`lp`) on Lloyd's mini (nothing leaves the house); chief tools
      `print_document` + `list_printers`, audited. Lazy/defensive (clear message if no
      lp/printer). Unit-verified (job-id parse, failure, missing-file, listing). GO-LIVE:
      add a printer on the mini + set `PRINTER_NAME` (or rely on the system default) once
      the mini pulls this. Pairs with image generation (generate -> print).
- [x] **Per-agent `soul.md` + `decision.md`** — DONE. `decision.md` = `src/decisions.js`
      + per-agent `data/decisions/<agent>.md` (`log_decision`/`list_decisions` on every
      specialist). `soul.md` ≈ our `agents/*.md` — all six standardized + fleshed out
      (workstream O `[x]`, 2026-06-20) and the brains are seeded (O, 2026-06-26).
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
      - [~] read-only signal monitors — breach-feed monitor BUILT 2026-06-24
        (`src/security-monitor.js` checkBreaches via HaveIBeenPwned; new exposures ->
        high findings + owner alert; `securityPosture` summary; Frank `security_posture`
        tool). Inert until `HIBP_API_KEY` + `SECURITY_WATCH_EMAILS` set. Still TODO:
        device/OS-update status + home-system alerts (need local/device integrations).
      - [x] heartbeat security feed — `maybeSecurityScan()` runs the breach monitor on a
        weekly cadence from the heartbeat (Lloyd-side: it needs network + records
        findings + notifies, which a remote specialist must not do).
- [x] **Progressive trust (2026-06-24)** — `COS_TRUST_<AGENT>` narrows a specialist to a
      subset of its allowlist (plus the always-on memory/decision baseline) while it
      earns trust; unset = full allowlist (default), empty = observe-only. Narrows the
      K#4 allowlist, never widens. `trustedTools()` in `agents/tools.js`, unit-tested.
