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

- [ ] `npm install` (deps declared, never installed in this clone)
- [ ] `cp .env.example .env` and fill: Anthropic, Twilio, Azure Storage, Graph
- [ ] `node _smoke.mjs` passes (guards, confirm, memory) — no creds needed
- [~] `npm run once` fires a single heartbeat tick end-to-end (needs Graph + Anthropic)
- [~] `npm start`, text the Twilio number, confirm queue → reply round-trip
- Parallel-safe: yes once creds exist; this is the gate that lets other streams
  *verify* their work rather than just write it.

### B. Front door (Azure Function)  `[ ]`  — EXTERNAL REPO

Owns: the existing Azure Functions project (NOT in this repo).

- [ ] Trim the SMS webhook to base64-enqueue `{from, body, channel, replyTo}` onto
      `inbound-messages` and ack Twilio immediately
- [ ] Same for the email handler
- Parallel-safe: fully independent — different repo, different session, no overlap
  with this codebase. Only the queue *message shape* is the contract (see
  `queue.js:9-11`). Pin that shape and this can proceed in total isolation.

### C. Graph / mailbox token debug  `[~]`  — was the old build's open item

Owns: `src/channels/graph.js`, `src/config.js` (GRAPH block only).

- [~] Verify app-only client-credentials token actually acquires the
      `.default` scope against the tenant
- [~] Confirm `recentMailSignals()` returns real headers from `assistant@freyfam.com`
- [ ] Confirm app registration has `Mail.Read` + `Mail.Send` *application* perms
      with admin consent (sendMail path)
- Parallel-safe: yes — isolated file. Needs real Graph creds (overlaps A on creds).

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

### H. Harden & operationalize  `[~]`

Owns: `src/queue.js`, `src/daemon.js`, `deploy/com.freyfam.cos.plist`, logging.

- [ ] Dead-letter after N dequeues using `m.dequeueCount` (`queue.js:52`)
- [ ] Structured logging (replace ad-hoc `console.*`)
- [ ] `pmset` / `caffeinate` so it runs lid-closed on power
- [~] Install `deploy/com.freyfam.cos.plist` (edit paths first), `launchctl load`
- Parallel-safe: mostly yes — `queue.js` and `deploy/` are isolated. Touches
  `daemon.js` lightly. Independent of E/F/G.

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

**Bottleneck (serialize):** D (proactive bug) and F (specialist tools) both edit
`orchestrator.js`. Do D first (it's small and a real bug), then F. Or assign both
to one session.

**Critical path to "it works at all":** A → (B + C) → D. Memory, specialists, and
browser make it *good*; the path above makes it *live*.

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
| **Theo** | Content creator | content generation | **replaced by → chef** (meal planning + food inventory; **new agent, no persona yet**) |
| _(none)_ | — | — | **+ security** (home + IT security) — Frey-specific, no Genet analog |

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
- [ ] **Photo / multimodal intake** (Sylvie) — inbound MMS → image content blocks.
      New: front door (B) must pass media URLs; orchestrator must build image blocks.
- [ ] **Image generation** (Sylvie) — a creative tool (Gemini or another provider).
      New tool module → wired in F.
- [ ] **Printer access** (Sylvie) — local print tool (pairs with browser stream G).
- [ ] **Per-agent `soul.md` + `decision.md`** — `soul.md` ≈ our `agents/*.md`
      (rename/align concept); `decision.md` is the new decision-log in E.
- [ ] **Add the `chef` agent** — net new. Concrete code:
      - new `src/agents/chef.md` persona (meal planning + food inventory)
      - add `"chef"` to the delegate enum (`orchestrator.js:43`)
      - add `"chef"` to both triage enums (`triage.js:25` inbound, `:57` heartbeat)
      - chef tools in F: meal planner, food-inventory read/write (inventory model
        is shared with the reseller's stock — see Sylvie note above)
- [ ] **Add the `security` agent (Frank)** — persona `src/agents/security.md` already
      written. Remaining wiring (deferred, same files as chef):
      - add `"security"` to the delegate enum (`orchestrator.js:43`)
      - add `"security"` to both triage enums (`triage.js:25` inbound, `:57` heartbeat)
      - security tools in F: read-only signal monitors (auth/login events, breach
        feeds, device/update status, home-system alerts); all control actions
        (arm/disarm, lock, password/account changes) stay behind the confirmation gate
      - heartbeat fit: security signals are a natural proactive feed — extend
        `gatherSignals()` (`heartbeat.js:23`) alongside calendar deltas
- [ ] **Progressive trust** — start specialists with minimal tools, widen over time.
      Bake into F by gating powerful tools behind config flags.
