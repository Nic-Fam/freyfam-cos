# Setup: Steve (dev) — MacBook

Steve is the **dev specialist**, run locally on an old MacBook for code/device
access. Like Frank, he runs the HTTP harness `deploy/specialists/local-server.mjs`
(`npm run specialist`) and Lloyd reaches him over the LAN with the same
`{agent,task} -> {text}` contract, key auth, and agent pin.

**What makes Steve different (workstream Q):** instead of the metered Anthropic API,
Steve's runner shells out to a **Claude Code subscription** (headless `claude -p`).
Dev work — file edits, running tests, building the household's little apps — is
exactly Claude Code's wheelhouse, flat-rate billing takes the heaviest agent off
per-token cost, and it's a capability upgrade: Steve gets real file/bash/build tools
instead of the text-only runner. The `delegate` contract is unchanged; only Steve's
execution backend differs, and only when `COS_DEV_BACKEND=claude-code`.

> Code reference: `src/specialists/dev-claude-code.js` + the `DEV` block in
> `src/config.js`. The runner branches to this backend for `agent==="dev"`.

---

## 0. What this box must have when you're done

- Node 22+, this repo checked out, a minimal `.env`.
- **Claude Code installed and logged into the subscription** (OAuth profile).
- **`ANTHROPIC_API_KEY` NOT in this process's environment** (it shadows the
  subscription — see the critical gotcha below).
- A stable LAN hostname + a function key that matches Lloyd's `COS_SPECIALIST_KEY_DEV`.
- The specialist server running under `launchd`, pinned to `COS_AGENT=dev`,
  `COS_DEV_BACKEND=claude-code`.

---

## ⚠️ The critical gotcha: API key SHADOWS the subscription

Claude Code resolves a **subscription via OAuth profile** (`claude /login`) — no API
key. But if `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) is present, it **wins
credential precedence** and Claude Code uses the metered API instead, defeating the
entire point (and a key + auth token together can 401).

Two layers protect against this:
1. The backend's `subscriptionEnv()` **deletes** both vars from the child process it
   spawns, so the subscription always wins for delegated dev tasks.
2. You should still **keep `ANTHROPIC_API_KEY` out of Steve's environment** entirely
   (don't set it in `.env` or the plist) so nothing — a manual `claude` run, the
   fallback path — accidentally bills the API.

Trade-off to decide (see `COS_DEV_FALLBACK_API` in step 4): pure subscription vs. a
metered safety net when the subscription cap is hit.

---

## 1. macOS + network prep

1. **Name the host**: System Settings → General → Sharing → Local hostname →
   `steve` (gives `steve.local`). Static DHCP lease recommended.
2. **Power**: prevent sleep when display off, start up after power failure, wake for
   network access — so Lloyd can reach Steve whenever he delegates. (A clamshell
   MacBook on AC needs the lid-closed step below.)
3. **Firewall**: allow incoming connections for `node` if the firewall is on. Server
   listens on `8787` by default.
4. Command Line Tools:
   ```bash
   xcode-select --install
   ```

## 2. Node 22

```bash
brew install node@22     # or a pinned ~/.local tarball
node -v                  # v22.x
which node               # note the absolute path for launchd
```

## 3. Install Claude Code + log into the subscription

```bash
# install the CLI (see https://claude.com/claude-code for the current installer)
npm install -g @anthropic-ai/claude-code     # or the documented install method
which claude                                 # note the absolute path -> CLAUDE_CODE_BIN

# authenticate ONCE against the subscription (interactive, opens a browser):
claude     # then run /login inside the session and choose the subscription
```

Verify the subscription works headlessly **with the API key unset**:
```bash
env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN \
  claude -p "say hello in five words" --output-format json
# expect JSON with "is_error": false and a "result" string — and NO API spend
```

> The OAuth profile is a credential on this machine (persisted by Claude Code), not
> an `.env` value. Confirm the subscription's **usage limits** (Max/Pro caps) are
> enough for the expected dev volume.

## 4. Minimal `.env`

Steve needs **no** Anthropic API key, Twilio, Graph, or queue creds — the
subscription handles reasoning and Lloyd owns everything outward-facing.

```bash
cp .env.example .env
```

Set:
```ini
# --- This server's identity / auth ---
COS_AGENT=dev                      # pins this process to ONE agent; misroutes get 403
COS_SPECIALIST_LOCAL_KEY=<long-random-key>   # must equal Lloyd's COS_SPECIALIST_KEY_DEV
PORT=8787

# --- Workstream Q: route Steve to the Claude Code subscription ---
COS_DEV_BACKEND=claude-code        # api | claude-code
CLAUDE_CODE_BIN=claude             # or the absolute path from `which claude`
COS_DEV_CWD=/Users/<user>/steve-workspace   # the dir Steve edits/builds in
COS_DEV_TIMEOUT_MS=180000          # per-task budget (a build/test run can be slow)
COS_DEV_FALLBACK_API=false         # see below

# --- Local-time + memory (local JSON on this Mac; recall runs before the dev branch) ---
FAMILY_TZ=America/Los_Angeles

# IMPORTANT: do NOT set ANTHROPIC_API_KEY on this box.
```

**`COS_DEV_FALLBACK_API`:**
- `false` (recommended for pure subscription) — if the subscription cap is hit, the
  delegation returns a clear error to Lloyd. No surprise API spend. Keeps the API key
  off the box.
- `true` — on a cap/timeout, Steve spills back to the metered API loop. That path
  needs `ANTHROPIC_API_KEY` present in Steve's env to actually work; note that adding
  the key is safe for the subscription itself (the `claude -p` child still scrubs it)
  but it means a cap silently becomes metered spend. Only enable if you want that
  safety net and accept the cost.

> Make `COS_DEV_CWD` a directory Steve is allowed to operate in (e.g. a clone of the
> app he maintains). Claude Code's file/bash tools act there — never on the family's
> behalf; outbound + confirmation still live only on Lloyd.

## 4b. Seed Steve's brain (recommended)

`data/brain.json` and `data/seed-family-domains.json` are **gitignored** (sensitive
household data) so `git clone` does not bring them. Transfer the seed source **out of
band** (AirDrop / scp / USB), never via git, then seed — recall filters by agent, so
this box only surfaces `dev`-scoped notes (the handoff pointer, stack, dev approach,
your Claude Code backend, dev hard rules) plus shared facts:

```bash
npm run seed                                # shared starter facts (in git)
node data/seed-family-identity.mjs          # family identity backfill
npm run seed data/seed-family-domains.json  # surfaces Steve's dev-scoped + shared notes
```

Idempotent; safe to re-run. (Or copy a populated `data/brain.json` over directly.) The
dev handoff itself, `docs/STEVE_HANDOFF.md`, IS in git. See Lloyd's setup §5 for the
canonical explanation.

## 5. Run it (foreground first)

```bash
COS_AGENT=dev PORT=8787 COS_SPECIALIST_LOCAL_KEY=<key> npm run specialist
# -> [specialist] local specialist listening { agent: 'dev', port: 8787, authed: true }
```

### Verify locally — and confirm it used the subscription, not the API
```bash
curl -s -X POST http://localhost:8787/ \
  -H "content-type: application/json" \
  -H "x-functions-key: <key>" \
  -d '{"agent":"dev","task":"In one sentence, what would you check first if a Node daemon exits on boot?"}'
# expect {"text":"..."}
```
Then confirm there was **no Anthropic API usage** for that call in the Console (it
should have gone against the subscription). Wrong-agent → 403, bad/missing key → 401,
same as Frank.

From **Lloyd's** box, repeat against `http://steve.local:8787/` to confirm the LAN path.

## 6. Run under launchd

Create `~/Library/LaunchAgents/com.freyfam.steve.plist` (structure from
`deploy/com.freyfam.cos.plist`, running the specialist entry point):

```xml
<key>Label</key>            <string>com.freyfam.steve</string>
<key>ProgramArguments</key>
<array>
  <string>/usr/bin/caffeinate</string>
  <string>-is</string>
  <string>/ABS/PATH/TO/node</string>
  <string>/Users/<user>/freyfam-cos/deploy/specialists/local-server.mjs</string>
</array>
<key>WorkingDirectory</key> <string>/Users/<user>/freyfam-cos</string>
<key>EnvironmentVariables</key>
<dict>
  <key>COS_AGENT</key>               <string>dev</string>
  <key>PORT</key>                    <string>8787</string>
  <key>COS_SPECIALIST_LOCAL_KEY</key><string><key></string>
  <key>COS_DEV_BACKEND</key>         <string>claude-code</string>
  <key>CLAUDE_CODE_BIN</key>         <string>/ABS/PATH/TO/claude</string>
  <key>COS_DEV_CWD</key>             <string>/Users/<user>/steve-workspace</string>
  <!-- deliberately NO ANTHROPIC_API_KEY here -->
</dict>
<key>RunAtLoad</key>  <true/>
<key>KeepAlive</key>  <true/>
<key>StandardOutPath</key> <string>/Users/<user>/freyfam-cos/steve.out.log</string>
<key>StandardErrorPath</key><string>/Users/<user>/freyfam-cos/steve.err.log</string>
```

> launchd jobs do **not** inherit your shell `.zshrc`/`.zprofile` env. Make sure
> Claude Code's OAuth profile is readable by the user the LaunchAgent runs as (run
> `claude /login` as that same user), and that `PATH` covers `claude` and `node` — or
> use absolute paths as above.

Install + lid-closed:
```bash
launchctl load -w ~/Library/LaunchAgents/com.freyfam.steve.plist
sudo pmset -c disablesleep 1     # optional; revert with 0
```

## 7. Wire Lloyd

On **Lloyd's** Mac mini `.env`:
```ini
COS_SPECIALIST_MODE=remote
COS_SPECIALIST_URL_DEV=http://steve.local:8787/
COS_SPECIALIST_KEY_DEV=<same key>
```
Restart Lloyd's daemon, delegate a dev task, and confirm Steve answers over the LAN
on the subscription.

---

## Notes & troubleshooting

- **ToS:** confirm the subscription's terms allow this automated household use before
  relying on it.
- **`claude` not found under launchd** → set `CLAUDE_CODE_BIN` to the absolute path;
  LaunchAgents don't load your interactive shell `PATH`.
- **It's billing the API, not the subscription** → `ANTHROPIC_API_KEY` is set
  somewhere in Steve's environment. Remove it from `.env` and the plist; verify with
  `env | grep ANTHROPIC` in the same context the server runs.
- **Tasks error with "usage limit reached"** → the subscription cap is hit. Either
  wait for reset, or set `COS_DEV_FALLBACK_API=true` **and** provide an API key (see
  step 4 trade-off).
- **Restart after code pulls / `.env` changes** — Node caches imported modules, so
  new code only loads on restart. Follow the full safe-restart procedure in
  [`restart.md`](./restart.md) (pre-flight → `kickstart -k` → verify), which is the
  same sequence used on Lloyd; Steve's label is `com.freyfam.steve`. Quick form:
  ```bash
  launchctl kickstart -k gui/$(id -u)/com.freyfam.steve
  pgrep -fl deploy/specialists/local-server.mjs    # confirm a fresh PID
  tail -5 steve.out.log steve.err.log              # expect "local specialist listening", no NEW errors
  ```
- **Memory persists** on this Mac's local disk (no Azure Tables needed for a local box).
- **Hard constraint:** Steve returns text only. The file/bash/build tools act in
  `COS_DEV_CWD`, never as the family; every real-world effect goes through Lloyd's
  confirmation gate.
