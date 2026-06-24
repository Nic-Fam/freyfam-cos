# Setup: Lloyd (chief of staff) — Mac mini

Lloyd is the **host**, not a delegated specialist. This Mac mini runs the full
daemon and owns everything trust-critical: the front-door queue consumer, inbound
triage, the **confirmation gate**, **all outbound channels** (Twilio SMS + Microsoft
Graph email), `guards.isWorkDomain()`, the morning digest, the heartbeat, the cost
watchdog, and Lloyd's own local memory. The five specialists run elsewhere (Frank +
Steve on the LAN, finance/resale/chef on Azure) and only ever return text to Lloyd.

> Do this one **after** Frank's and Steve's Macs are online, so you have their LAN
> URLs + keys to paste into Lloyd's `.env` (the last wiring step).

---

## 0. What this box must have when you're done

- Node 22+, this repo checked out, `.env` fully filled.
- Reaches the Azure inbound queue (pulls messages), Twilio, and Microsoft Graph.
- Reaches Frank and Steve over the LAN (`http://<host>:8787/`).
- Runs lid-closed on AC power under `launchd`, auto-restarting on crash + nightly.

---

## 1. macOS + network prep

1. **Name the host** so the LAN address is stable. System Settings → General →
   Sharing → set **Local hostname** to `lloyd` (gives `lloyd.local`). Optionally
   reserve a static DHCP lease for it on the router.
2. **Power**: System Settings → Energy →
   - "Prevent automatic sleeping when the display is off" → **on**
   - "Start up automatically after a power failure" → **on**
   - "Wake for network access" → **on**
   This box should never sleep — it's pulling the queue continuously.
3. **Create a dedicated login user** (e.g. `cos`) that the daemon runs as, and enable
   automatic login for it so the daemon comes back after a reboot.
4. Install **Xcode Command Line Tools** (needed for git + some native deps):
   ```bash
   xcode-select --install
   ```

## 2. Node 22

Use whatever you standardize on; two options:

```bash
# Option A: Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node@22

# Option B: a pinned tarball under ~/.local (matches the launchd plist's node path)
# https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz  (arm64 for Apple silicon)
```

Confirm:
```bash
node -v   # v22.x
```

> Note the **absolute path** to this `node` binary (`which node`) — you'll hard-code
> it in the launchd plist in step 7.

## 3. Get the code

```bash
cd ~
git clone https://github.com/Nic-Fam/freyfam-cos.git
cd freyfam-cos
npm install          # clean, no native build issues on macOS
```

Smoke-test with zero creds/network:
```bash
node _smoke.mjs      # guards + confirm parser + memory round-trip
npm test             # full suite (runs offline; EMBEDDINGS_PROVIDER=none)
```

## 4. Fill in `.env`

```bash
cp .env.example .env
```

Lloyd needs the **full** set (he's the only host that talks to the outside world).
Open `.env` and fill:

- **Anthropic** — `ANTHROPIC_API_KEY` (inference key). Model tiers can stay default.
- **Twilio** — `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (or
  `TWILIO_MESSAGING_SERVICE_SID`), `OWNER_PHONE` (where approvals + FYIs go).
- **Azure Storage Queue** — `AZURE_STORAGE_CONNECTION_STRING`, `INBOUND_QUEUE_NAME`
  (same storage account as the front-door Function, so the handoff is wired by
  construction).
- **Microsoft Graph** — `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`,
  `GRAPH_MAILBOX=cos@freyfam.com`, plus `GRAPH_CALENDARS` / `GRAPH_CALENDAR_WRITE`.
- **Cost watchdog** — `ANTHROPIC_ADMIN_KEY` (admin key, not the inference key) and the
  Azure cost SP creds, if you want spend alerts.
- **Digest / TZ** — `FAMILY_TZ=America/Los_Angeles`, `DIGEST_EMAIL_TO`.
- Optional: `BRAVE_SEARCH_KEY` (web search), `AZURE_MAPS_KEY` (commute times),
  `SLACK_APP_TOKEN`/`SLACK_BOT_TOKEN` (desk channel).

### Specialist transport (the LAN + Azure wiring)

This is the part unique to the host. Set the seam to remote and point each
specialist at its host:

```ini
COS_SPECIALIST_MODE=remote

# LAN Macs (fill once Frank + Steve are online — steps from their guides):
COS_SPECIALIST_URL_SECURITY=http://frank.local:8787/
COS_SPECIALIST_KEY_SECURITY=<same key Frank runs with>
COS_SPECIALIST_URL_DEV=http://steve.local:8787/
COS_SPECIALIST_KEY_DEV=<same key Steve runs with>

# Azure Functions (from deploy/publish-specialists.sh output):
COS_SPECIALIST_URL_FINANCE=https://<app>.azurewebsites.net/api/specialist
COS_SPECIALIST_KEY_FINANCE=<function key>
COS_SPECIALIST_URL_RESALE=https://<app>.azurewebsites.net/api/specialist
COS_SPECIALIST_KEY_RESALE=<function key>
COS_SPECIALIST_URL_CHEF=https://<app>.azurewebsites.net/api/specialist
COS_SPECIALIST_KEY_CHEF=<function key>
```

> **Per-agent cutover:** any specialist with **no URL set** runs in-process on Lloyd
> as a graceful fallback. So you can bring the fleet online one box at a time — leave
> `COS_SPECIALIST_URL_DEV` blank until Steve's MacBook is up, and Steve just runs
> inside Lloyd meanwhile.

## 5. Seed this box's brain (recommended)

The brain (`data/brain.json`) and the durable family seed (`data/seed-family-domains.json`)
are **gitignored** — they hold sensitive household data (finances, home-security
topology, sizes) and must never reach GitHub. So a fresh `git clone` does **not** bring
them. Transfer the seed source to this machine **out of band** (AirDrop / scp / USB),
never via git, then seed:

```bash
npm run seed                              # data/seed-notes.json (in git): shared starter facts
node data/seed-family-identity.mjs        # family identity backfill (emails, profiles, logistics)
npm run seed data/seed-family-domains.json  # per-specialist family data (chef/security/resale/finance/dev + shared)
```

All seeds are idempotent (dedupe by exact text), so re-running is safe. Recall filters
by agent, so seeding the full `seed-family-domains.json` on any box only surfaces that
box's agent-scoped notes plus shared facts. Embeddings download a ~90MB model once to
`data/models` on first real run (local, on-device; no key); set
`EMBEDDINGS_PROVIDER=none` to skip semantic recall.

> Alternatively, copy a populated `data/brain.json` over directly (same out-of-band
> transfer) instead of re-running the seeds — useful to mirror Lloyd's current brain to
> a new box. Keep `BRAIN_PATH` pointed at this machine's local copy.

## 6. First live run (foreground)

```bash
npm run once     # single heartbeat tick end-to-end (cheap; verifies creds)
npm start        # full daemon: queue consumer + heartbeat
```

Watch for `[queue] consuming "inbound-messages"` and a scheduled heartbeat. Text the
Twilio number (or enqueue a synthetic email message) and confirm the round-trip:
queue → triage → specialist → reply. `Ctrl-C` when satisfied.

### Verify the LAN reaches the specialists
From Lloyd, with Frank/Steve running:
```bash
curl -s -X POST http://frank.local:8787/ \
  -H "content-type: application/json" \
  -H "x-functions-key: $COS_SPECIALIST_KEY_SECURITY" \
  -d '{"agent":"security","task":"ping"}'
# expect {"text":"..."}
```

## 7. Run under launchd (lid-closed, auto-restart)

1. Edit `deploy/com.freyfam.cos.plist`: set the **node path** (step 2) and the
   **WorkingDirectory** to this checkout (`/Users/<user>/freyfam-cos`). The program is
   wrapped in `caffeinate -is` already so it won't idle/system-sleep on AC.
2. Install:
   ```bash
   cp deploy/com.freyfam.cos.plist ~/Library/LaunchAgents/
   launchctl load -w ~/Library/LaunchAgents/com.freyfam.cos.plist
   ```
3. For **true lid-closed** operation on power, once, with sudo:
   ```bash
   sudo pmset -c disablesleep 1     # revert: sudo pmset -c disablesleep 0
   ```
4. **Nightly restart** (picks up deployed code changes; safe — all state persists to
   `data/` + the queue):
   ```bash
   # edit the uid in the plist to match `id -u`, then:
   cp deploy/com.freyfam.cos.restart.plist ~/Library/LaunchAgents/
   launchctl load -w ~/Library/LaunchAgents/com.freyfam.cos.restart.plist
   ```

Logs land in the checkout as `cos.out.log` / `cos.err.log` (and `cos.restart.log`).

## 8. Operate

```bash
# restart after a code pull / .env change (in-memory module cache is why):
launchctl kickstart -k gui/$(id -u)/com.freyfam.cos

# tail logs
tail -f cos.out.log cos.err.log

# stop / start
launchctl unload ~/Library/LaunchAgents/com.freyfam.cos.plist
launchctl load   ~/Library/LaunchAgents/com.freyfam.cos.plist
```

> Before restarting Lloyd, **check `data/pending-approvals.json` is `{}`** so an
> in-flight confirmation isn't dropped, then verify the process came back. The full
> safe-restart procedure (shared with the specialist boxes) is in
> [`restart.md`](./restart.md).

---

## Hard constraints this box owns (do not regress)

- **All outbound and the confirmation gate live here.** Specialists only return text;
  spending money, sending SMS/email, and creating calendar invites all route through
  `confirm.js` on Lloyd. Never auto-approve.
- **Work-domain recipients** (`flyerdefense.com`, `disney.com`) are flagged by
  `guards.isWorkDomain()` and go through the confirmation gate.
- **No money movement** — finance only surfaces actions.

## Troubleshooting

- **Daemon exits immediately** → check `cos.err.log`; usually a missing `.env` key.
- **No replies but queue drains** → Twilio number not cleared, or Graph `Mail.Send`
  consent missing. Email path is the reliable fallback while SMS clears.
- **A specialist call hangs/fails** → Lloyd surfaces a graceful "couldn't reach the X
  specialist" message and does **not** fall back to running it locally (that would
  break isolation). Check the specialist box is up and the key matches.
- **Code change not taking effect** → restart the daemon (kickstart above); a
  long-running Node process caches imported modules.
