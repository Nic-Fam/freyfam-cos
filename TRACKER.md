# TRACKER.md - Frey Family Chief of Staff

Development tracker for getting the daemon from "scaffold that compiles" to
"agents that actually work" (the Genet-grade bar). Read **CLAUDE.md** first for
architecture and hard constraints; this file tracks *state* and *who-can-do-what-
in-parallel*.

Last synced to code: 2026-06-19 (commit `82a6423`).

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
suite (49 tests).

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

### I. Multimodal / MMS intake  `[~]`  — daemon half DONE 2026-06-19; front door pending (cross-repo)

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

### L. Document intake (PDF / .ics / .vcf) over email  `[~]`  — DAEMON HALF DONE 2026-06-20

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
- [ ] Routing polish: nudge receipts→finance, invites→Lloyd scheduling, etc. (the
      chief already delegates from the extracted text; this is tuning, not blocking).
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

### M. Voice calling  `[ ]`  — FUTURE SCOPE (not started)

A third human channel alongside SMS and Slack: the family calls (or is called by)
the assistant. Twilio Programmable Voice / ConversationRelay (we already have the
Twilio account + number). **Read this before building — there's a real architecture
tension**, so it splits into two tiers.

**The tension:** the whole design is pull-only — the Mac is never publicly reachable
(Twilio → Azure Function → queue → Mac pulls). A *live* voice agent needs a
persistent **public WebSocket** (ConversationRelay / media streams) with
conversation-latency response, which a queue round-trip can't meet and the home Mac
must not expose. So real-time voice cannot live on Lloyd's Mac the way SMS does.

**Tier 1 — async voice (fits the pull model, do first):**
- [ ] **Inbound voicemail → text.** Call hits the number → Twilio records + transcribes
      → the front door enqueues `{channel:"voice", body:<transcript>, …}` (+ optional
      recording URL as media). Flows through the EXISTING pipeline; Lloyd replies by
      SMS or callback. (This also closes the "forwarded-voicemail audio" media-gap note.)
- [ ] **Outbound calls (notify / simple IVR).** Lloyd initiates via Twilio
      `calls.create()` (outbound HTTP — no public endpoint needed); TwiML hosted in the
      Azure front door. **High-stakes → confirm gate + `guards.js`** (placing a call on
      the family's behalf), same posture as `send_email`/`place_order`.

**Tier 2 — real-time conversational voice (needs Azure, like the specialists):**
- [ ] Live two-way voice via **ConversationRelay** (ASR + TTS + streaming). The public
      WebSocket + agent loop run **in Azure**, reusing `runChief`/`runSpecialist`
      (transport-agnostic) — NOT on the home Mac. Treat it as another remote
      participant in the hybrid topology, not a Lloyd-local channel.

**Constraints / notes:**
- Outbound voice is its own Twilio trust program (STIR/SHAKEN, Voice Integrity) —
  registration before traffic, like A2P was for SMS. Skills available:
  `twilio-voice-twiml`, `twilio-voice-outbound-calls`, `twilio-voice-conversation-relay`.
- Hard constraints unchanged: a specialist never dials out; outbound calling stays a
  Lloyd capability behind confirmation.
- Recording/transcription has consent implications (two-party-consent states) — gate
  before recording.
- Parallel-safe: Tier 1 reuses the queue contract (add `channel:"voice"`) + front
  door; Tier 2 is an Azure-side build independent of Lloyd. Sequence Tier 1 first.

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

### Q. Steve on a Claude Code subscription (not the API)  `[~]`  — backend BUILT + VERIFIED LIVE 2026-06-22 (merged to main); go-live is the MacBook login

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

### R. Resilience & disaster recovery (local hardware failure / power outage)  `[ ]`  — BIG ITEM, added 2026-06-24

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
- [ ] **Auto-power-on after an outage.** launchd restarts the daemon on boot, but the
      Mac must boot itself first: set `sudo pmset -a autorestart 1` (power back →
      Mac powers on) and confirm the firmware "start up after power failure" setting.
      One-time host config; document in `deploy/setup/lloyd-mac-mini.md`.
- [ ] **UPS + graceful shutdown.** A small uninterruptible power supply rides out short
      outages and, on a long one, signals the Mac to shut down cleanly (avoids
      mid-write corruption of the JSON state). macOS reads many UPS units natively
      (Energy Saver → shut down on low battery). Cheap, high-value hardware mitigation.
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
      - [x] `memory.js` — DONE 2026-06-24. Migrated onto the pluggable collection store
        (local brain.json by default, identical format; MI Azure Table when COS_TABLE_*
        is set). Durable memory for workstream R (survives disk loss natively) AND the
        remote-recall path for the Azure split. recall/remember unchanged; verified
        against the existing 1.6MB brain.
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
- [ ] **Move resale (Shey) back to Azure (remote) — reverted to LOCAL 2026-06-24 for
      debugging; intended topology is remote.** `COS_SPECIALIST_URL_RESALE` is
      commented out in the live `.env`, so resale runs in-process on Lloyd (current
      code + tool-call tracing, no cold-start timeouts). Decision (2026-06-24): keep it
      local for a few days to confirm stability, THEN restore remote. The earlier
      remote failures were NOT Shey — the loop was the chief's turn cap (fixed,
      8→12) — but the remote Function still runs STALE code and was throwing
      `"This operation was aborted"` (delegate timeout on cold start + multi-turn work).
      To move back cleanly: (1) `bash deploy/publish-specialists.sh` to redeploy resale
      with current code (allowlist enforcement + the new tool-call tracing); (2) bump
      `COS_SPECIALIST_TIMEOUT_MS` (30s → ~60s) to absorb cold starts; (3) uncomment
      `COS_SPECIALIST_URL_RESALE` in `.env` + restart the daemon; (4) verify a real
      resale `delegate` round-trips without aborting and that traces show up.

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
      - [~] read-only signal monitors — breach-feed monitor BUILT 2026-06-24
        (`src/security-monitor.js` checkBreaches via HaveIBeenPwned; new exposures ->
        high findings + owner alert; `securityPosture` summary; Frank `security_posture`
        tool). Inert until `HIBP_API_KEY` + `SECURITY_WATCH_EMAILS` set. Still TODO:
        device/OS-update status + home-system alerts (need local/device integrations).
      - [x] heartbeat security feed — `maybeSecurityScan()` runs the breach monitor on a
        weekly cadence from the heartbeat (Lloyd-side: it needs network + records
        findings + notifies, which a remote specialist must not do).
- [ ] **Progressive trust** — start specialists with minimal tools, widen over time.
      Bake into F by gating powerful tools behind config flags.
