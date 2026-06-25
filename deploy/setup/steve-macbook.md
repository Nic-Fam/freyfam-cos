# Setup: Steve (dev) — MacBook

Steve is the **dev specialist**, run locally on an old MacBook for code/device
access. Like Frank, he runs the HTTP harness `deploy/specialists/local-server.mjs`
(`npm run specialist`) and Lloyd reaches him over the LAN with the same
`{agent,task} -> {text}` contract, key auth, and agent pin.

**Steve runs on the metered Anthropic API, like every other specialist.** An earlier
design ran him on a flat-rate Claude Code *subscription* (headless `claude -p`); that
was **removed 2026-06-25** because driving a Claude subscription headlessly from an
automated agent violates Anthropic's terms of service. There is no subscription
backend anymore.

**How Steve keeps cost low instead:** he proposes changes (he does not edit files
himself), and he triages by size — small, well-scoped tweaks he handles directly on
the API (cheap), and large or open-ended work he hands off to Nic to run in a
**human-driven remote Claude Code session**, with a crisp brief. He also coordinates
the dev backlog (his items + Nic's) via `propose_change` / `list_proposals`. See his
persona (`src/agents/dev.md`).

---

## 0. What this box must have when you're done

- Node 22+, this repo checked out, a minimal `.env`.
- An **`ANTHROPIC_API_KEY`** in this process's environment (Steve reasons via the API).
- A stable LAN hostname + a function key that matches Lloyd's `COS_SPECIALIST_KEY_DEV`.
- The specialist server running under `launchd`, pinned to `COS_AGENT=dev`.

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

## 3. Minimal `.env`

Steve needs an **Anthropic API key** (for reasoning) plus his identity/auth. He needs
no Twilio, Graph, or queue creds — Lloyd owns everything outward-facing.

```bash
cp .env.example .env
```

Set:
```ini
# --- This server's identity / auth ---
COS_AGENT=dev                      # pins this process to ONE agent; misroutes get 403
COS_SPECIALIST_LOCAL_KEY=<long-random-key>   # must equal Lloyd's COS_SPECIALIST_KEY_DEV
PORT=8787

# --- Reasoning (metered API, same as the other specialists) ---
ANTHROPIC_API_KEY=sk-ant-...        # Steve runs on the API; keep usage low via triage

# --- Local-time + memory (local JSON on this Mac) ---
FAMILY_TZ=America/Los_Angeles
```

> There is no `COS_DEV_BACKEND` / `CLAUDE_CODE_BIN` / `COS_DEV_FALLBACK_API` anymore —
> those configured the removed subscription backend. Do **not** install or wire a
> headless `claude` CLI for Steve.

## 4. Run it (foreground first)

```bash
COS_AGENT=dev PORT=8787 COS_SPECIALIST_LOCAL_KEY=<key> npm run specialist
# -> [specialist] local specialist listening { agent: 'dev', port: 8787, authed: true }
```

### Verify locally
```bash
curl -s -X POST http://localhost:8787/ \
  -H "content-type: application/json" \
  -H "x-functions-key: <key>" \
  -d '{"agent":"dev","task":"In one sentence, what would you check first if a Node daemon exits on boot?"}'
# expect {"text":"..."}
```
Wrong-agent → 403, bad/missing key → 401, same as Frank.

From **Lloyd's** box, repeat against `http://steve.local:8787/` to confirm the LAN path.

## 5. Run under launchd

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
  <key>ANTHROPIC_API_KEY</key>       <string>sk-ant-...</string>
</dict>
<key>RunAtLoad</key>  <true/>
<key>KeepAlive</key>  <true/>
<key>StandardOutPath</key> <string>/Users/<user>/freyfam-cos/steve.out.log</string>
<key>StandardErrorPath</key><string>/Users/<user>/freyfam-cos/steve.err.log</string>
```

> launchd jobs do **not** inherit your shell `.zshrc`/`.zprofile` env, so set
> `ANTHROPIC_API_KEY` in the plist (as above) or via a sourced env file the job reads.

Install + lid-closed:
```bash
launchctl load -w ~/Library/LaunchAgents/com.freyfam.steve.plist
sudo pmset -c disablesleep 1     # optional; revert with 0
```

## 6. Wire Lloyd

On **Lloyd's** Mac mini `.env`:
```ini
COS_SPECIALIST_MODE=remote
COS_SPECIALIST_URL_DEV=http://steve.local:8787/
COS_SPECIALIST_KEY_DEV=<same key>
```
Restart Lloyd's daemon, delegate a dev task, and confirm Steve answers over the LAN.

---

## Notes & troubleshooting

- **Large dev tasks:** Steve will not grind a big feature/refactor out on the metered
  API. He returns a "remote-session job" recommendation with a brief — run it yourself
  in a remote Claude Code session. That's by design (cost + ToS), not a failure.
- **Cost:** Steve's API spend stays low because he only fully works small tweaks; the
  cost watchdog still alerts at the usual threshold.
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
- **Hard constraint:** Steve returns text only (proposals/plans). He never edits,
  deploys, or sends; every real-world effect goes through Lloyd's confirmation gate.
