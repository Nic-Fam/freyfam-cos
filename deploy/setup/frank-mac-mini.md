# Setup: Frank (security) — Mac mini

Frank is the **security specialist**, run locally on a Mac mini so he can reach
home-network/security surfaces and keep that data on-premises. He runs the plain
HTTP harness `deploy/specialists/local-server.mjs` (`npm run specialist`), which
serves the SAME `{agent,task} -> {text}` contract, function-key auth, and agent pin
as the Azure handler. Lloyd reaches him over the LAN.

Frank uses the **standard API-backed runner** (`src/specialists/runner.js` →
`claude.js` → Anthropic API). He has his scoped security tools (findings add/list),
agent-scoped memory, and a decision log — but **no outbound channel and no
confirmation power**. Those live only on Lloyd, wherever Frank runs.

---

## 0. What this box must have when you're done

- Node 22+, this repo checked out, a minimal `.env`.
- `ANTHROPIC_API_KEY` (Frank reasons via the API).
- A stable LAN hostname + a function key that matches what Lloyd sends.
- The specialist server running under `launchd`, pinned to `COS_AGENT=security`.

---

## 1. macOS + network prep

1. **Name the host**: System Settings → General → Sharing → Local hostname →
   `frank` (gives `frank.local`). Reserve a static DHCP lease if you can — Lloyd
   addresses Frank by this hostname.
2. **Power**: System Settings → Energy → prevent sleep when display off, start up
   after power failure, wake for network access. Frank should be reachable whenever
   Lloyd delegates.
3. **Firewall**: if macOS firewall is on, allow incoming connections for `node`
   (System Settings → Network → Firewall → Options). The server listens on a LAN
   port (default `8787`).
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

## 3. Get the code

```bash
cd ~
git clone https://github.com/Nic-Fam/freyfam-cos.git
cd freyfam-cos
npm install
node _smoke.mjs          # offline sanity check
```

## 4. Minimal `.env`

Frank does **not** need Twilio, Graph, the queue, or the cost watchdog — those are
Lloyd's. He needs just enough to reason and to authenticate the LAN call:

```bash
cp .env.example .env
```

Set:
```ini
# --- Anthropic (Frank reasons via the API) ---
ANTHROPIC_API_KEY=sk-ant-...

# --- This server's identity / auth ---
COS_AGENT=security                 # pins this process to ONE agent; misroutes get 403
COS_SPECIALIST_LOCAL_KEY=<long-random-key>   # must equal Lloyd's COS_SPECIALIST_KEY_SECURITY
PORT=8787

# --- Local-time + memory (local JSON on this Mac's disk — persistent, unlike Azure) ---
FAMILY_TZ=America/Los_Angeles
# BRAIN_PATH=./data/brain.json      # default is fine; this is Frank's own scoped brain
# EMBEDDINGS_PROVIDER=local          # on-device recall; set "none" to skip the model download
```

> Generate a key: `openssl rand -hex 32`. Put the SAME value in Lloyd's `.env` as
> `COS_SPECIALIST_KEY_SECURITY`. A leaked key exposes only this one specialist.

Everything else in `.env.example` can stay blank on Frank's box.

## 4b. Seed Frank's brain (recommended)

`data/brain.json` and `data/seed-family-domains.json` are **gitignored** (sensitive
household data) so `git clone` does not bring them. Transfer the seed source **out of
band** (AirDrop / scp / USB), never via git, then seed — recall filters by agent, so
this box only surfaces `security`-scoped notes (alarm/cameras/locks, network topology,
VPN) plus shared facts:

```bash
npm run seed                                # shared starter facts (in git)
node data/seed-family-identity.mjs          # family identity backfill
npm run seed data/seed-family-domains.json  # surfaces Frank's security-scoped + shared notes
```

Idempotent; safe to re-run. (Or copy a populated `data/brain.json` over directly.) See
Lloyd's setup §5 for the canonical explanation.

## 5. Run it (foreground first)

```bash
COS_AGENT=security PORT=8787 COS_SPECIALIST_LOCAL_KEY=<key> npm run specialist
# -> [specialist] local specialist listening { agent: 'security', port: 8787, authed: true }
```

(If you put `COS_AGENT`/`PORT`/`COS_SPECIALIST_LOCAL_KEY` in `.env`, plain
`npm run specialist` works too.)

### Verify locally
```bash
curl -s -X POST http://localhost:8787/ \
  -H "content-type: application/json" \
  -H "x-functions-key: <key>" \
  -d '{"agent":"security","task":"List any obvious risks in leaving SSH open to the internet."}'
# expect {"text":"..."}

# wrong agent is refused:
curl -s -X POST http://localhost:8787/ -H "x-functions-key: <key>" \
  -d '{"agent":"finance","task":"hi"}'     # -> 403

# missing/bad key is refused:
curl -s -X POST http://localhost:8787/ -d '{"agent":"security","task":"hi"}'   # -> 401
```

Then from **Lloyd's** box, repeat the first curl against `http://frank.local:8787/`
to confirm the LAN path + DNS resolve.

## 6. Run under launchd

Create `~/Library/LaunchAgents/com.freyfam.frank.plist` (copy the structure from
`deploy/com.freyfam.cos.plist`, but run the specialist entry point). Key fields:

```xml
<key>Label</key>            <string>com.freyfam.frank</string>
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
  <key>COS_AGENT</key>               <string>security</string>
  <key>PORT</key>                    <string>8787</string>
  <key>COS_SPECIALIST_LOCAL_KEY</key><string><key></string>
</dict>
<key>RunAtLoad</key>  <true/>
<key>KeepAlive</key>  <true/>
<key>StandardOutPath</key> <string>/Users/<user>/freyfam-cos/frank.out.log</string>
<key>StandardErrorPath</key><string>/Users/<user>/freyfam-cos/frank.err.log</string>
```

> Prefer reading secrets from `.env` over inlining them in the plist if you'd rather
> not have the key in a LaunchAgent file — the server picks them up from the
> environment either way.

Install + lid-closed:
```bash
launchctl load -w ~/Library/LaunchAgents/com.freyfam.frank.plist
sudo pmset -c disablesleep 1     # optional; revert with 0
```

## 7. Wire Lloyd

On **Lloyd's** Mac mini `.env`:
```ini
COS_SPECIALIST_MODE=remote
COS_SPECIALIST_URL_SECURITY=http://frank.local:8787/
COS_SPECIALIST_KEY_SECURITY=<same key>
```
Restart Lloyd's daemon. Delegate a security task and confirm Frank answers over the
LAN.

---

## Notes

- **Memory persists here.** Unlike the ephemeral Azure Functions filesystem, Frank's
  local JSON brain + decision log live on this Mac's disk, so recall survives
  restarts with no extra setup. (If you ever want Frank on the Azure Table path, set
  `COS_TABLE_ENDPOINT`/`COS_TABLE_NAME` — not needed for a local Mac.)
- **Restart after code pulls** (`launchctl kickstart -k gui/$(id -u)/com.freyfam.frank`)
  — Node caches imported modules in memory. Full safe-restart procedure
  (pre-flight → restart → verify) in [`restart.md`](./restart.md).
- **Hard constraint:** Frank returns text only. He never sends, spends, or confirms;
  any action he surfaces is executed through Lloyd's confirmation gate.
