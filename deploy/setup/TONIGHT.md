# Tonight: stand up the two Mac minis (Lloyd + Frank)

A from-scratch project plan. Deep per-step mechanics live in `lloyd-mac-mini.md` and
`frank-mac-mini.md`; THIS is the order, the accounts, the downloads, and the things
only you can do. Strategy: on each mini, do minimal macOS setup → **install + log into
Claude Code → let Claude clone + install + configure** → you supply secrets + service
logins → launch + verify.

**Order:** Lloyd's mini FIRST (it's the host — everything hangs off it), Frank's mini
SECOND (Lloyd needs Frank's LAN address + key). **Steve's MacBook = another day.**

---

## The split: what only YOU can do vs. what Claude does

**Only you (Claude can't):**
- macOS first-boot + **Apple ID** sign-in.
- **`claude /login`** (the Claude Max subscription) — to drive the install.
- **`gh auth login`** (GitHub) — the repo is private; Claude can't clone without it.
- Provide the **`.env` secrets** (copy from this MacBook / your password manager — Claude must never fetch creds).
- **Service sign-ins** in Chrome (Lloyd only): ralphs.com, therealreal.com.
- **iMessage / BlueBubbles** setup (Lloyd only).
- **Power / FileVault / network** settings (need physical + sudo).

**Claude (after login + gh auth, from a kickoff prompt):** install Homebrew + Node 22,
clone the repo, `npm install`, `npm test`, `npm run restore` (pull state from backup),
`npx playwright install chrome`, write/load the `launchd` plist, set `pmset`, run the
health checks.

---

## MINI #1 — Lloyd (the always-on host)

### A. macOS + hardware (you, ~10 min)
1. First boot: create a dedicated user (e.g. `cos`), sign into **Apple ID**.
2. **Wired Ethernet** if possible (reliability), and give it a **static IP / DHCP
   reservation** on your router (so it's findable + stable).
3. Power: System Settings → **Energy** → "Start up automatically after a power failure" **ON**, "Prevent automatic sleeping when display is off" **ON**.
4. **FileVault decision (important for always-on):** FileVault requires a password at
   every boot to unlock the disk, which **breaks unattended auto-restart after a power
   outage** (workstream R). For a true always-on box, turn FileVault **OFF** and enable
   **automatic login** so it returns on its own. Trade-off: the disk (which holds creds +
   household data) is unencrypted. Reasonable for a home mini on your LAN, but your call.

### B. Accounts to log into (you)
- **Apple ID** (done in A).
- **Claude** — install Claude Code, then `claude /login` (Claude Max).
- **GitHub** — `gh auth login` (so Claude can clone the private repo).
- **Chrome → ralphs.com** (your grocery account, saved payment, "keep me signed in") and **therealreal.com** (Shelli's First Look) — for the ordering/feed automation.
- **Family iMessage** (for BlueBubbles, step D3) — if you want the text channel tonight.

### C. Hand it to Claude Code (paste this)
> Set up this Mac mini as "Lloyd", the always-on host for the freyfam-cos household
> daemon. (1) Install Homebrew + Node 22 if missing. (2) Clone
> github.com/Nic-Fam/freyfam-cos into ~/freyfam-cos. (3) `npm install` then `npm test`
> (offline suite — must pass). (4) STOP and tell me when you're ready for the `.env` —
> I'll paste it. (5) After `.env` is in place: `npm run restore` (pull Lloyd's brain +
> state from the Azure backup), `npx playwright install chrome`, then install + load
> `deploy/com.freyfam.cos.plist` under launchd (fix the node path + WorkingDirectory for
> this machine) and configure `pmset` for always-on. Verify the daemon boots clean:
> "queue consuming", "heartbeat scheduled", "slack socket mode connected". Do NOT send
> or order anything — just stand it up and run the health checks.

### D. Secrets + service logins (you — the parts Claude can't)
1. **`.env`** — copy this MacBook's `~/freyfam-cos/.env` to the mini (AirDrop or a
   password manager). It already has every cred (Anthropic, Azure Storage, Graph, Brave,
   Slack, Maps). Adjust machine paths if needed. (Optional now: `HIBP_API_KEY` +
   `SECURITY_WATCH_EMAILS` to turn on Frank's breach monitor.)
2. **Chrome profile for ordering:** sign Chrome into ralphs.com + therealreal.com, then
   set `BROWSER_CHANNEL=chrome` + `BROWSER_USER_DATA_DIR=<that profile's User Data dir>`
   in `.env` (see `live-ordering-setup.md`). Quit Chrome before automated runs.
3. **iMessage / BlueBubbles (the text channel — the fiddliest; OK to defer to a
   follow-up night, email/Slack work meanwhile):** install the **BlueBubbles server**,
   sign it into the family iMessage account, run its **Private API** helper, set a server
   password, then put `IMESSAGE_SERVER_URL` + `IMESSAGE_PASSWORD` in `.env`.

### E. Launch + verify
Claude's kickoff handles this, but the check: `npm run once` (one heartbeat tick, cheap)
then `launchctl ... kickstart` and confirm `cos.out.log` shows starting + queue + slack.
The dead-man's-switch + 6h backup start firing on their own.

### F. Migrate off this MacBook
Once the mini is verified live: **stop the daemon on this MacBook** (`launchctl unload`
its plist) so only ONE Lloyd runs. `npm run restore` already brought the brain/state to
the mini, so nothing's lost. Front door + Azure are untouched (cloud).

---

## MINI #2 — Frank (security specialist)

Simpler — no browser, no outbound, no secrets beyond an API key + a LAN key.

### A. macOS + network (you)
Same as Lloyd's A (dedicated user, static IP, power-on-after-failure, FileVault decision).
Also: allow the specialist port through the macOS firewall (LAN only).

### B. Accounts (you)
- Apple ID · `claude /login` · `gh auth login`. **No service sign-ins** (Frank has no
  browser/outbound).

### C. Hand it to Claude Code (paste this)
> Set up this Mac mini as "Frank", the security-specialist server for freyfam-cos.
> (1) Homebrew + Node 22. (2) Clone Nic-Fam/freyfam-cos into ~/freyfam-cos. (3) `npm
> install`. (4) I'll give you a minimal `.env` (Anthropic key + `COS_AGENT=security` +
> `COS_SPECIALIST_LOCAL_KEY`). (5) Run `npm run specialist` and confirm it logs
> `agent: 'security', authed: true`, then set it up under launchd (`com.freyfam.frank`)
> bound to the LAN. Tell me this box's **LAN IP** and the **key** so I can wire Lloyd to it.

### D. Secrets (you)
Minimal `.env`: Anthropic key, `COS_AGENT=security`, `COS_SPECIALIST_LOCAL_KEY=<openssl
rand -hex 32>`. Everything else blank. (See `frank-mac-mini.md`.)

### E. Wire Lloyd → Frank (back on Lloyd's mini)
Put Frank's address + key in Lloyd's `.env`:
`COS_SPECIALIST_URL_SECURITY=http://<frank-lan-ip>:8787` and
`COS_SPECIALIST_KEY_SECURITY=<the same key>`, set `COS_SPECIALIST_MODE=remote` for
security, restart Lloyd, and verify a `delegate({agent:"security"})` round-trips.

---

## External sites / changes checklist (not on the Macs)
- **GitHub:** the minis need read access to the private repo (`gh auth login` per box, or add each box's SSH key).
- **Router:** static IP / DHCP reservation for each mini (stable LAN addressing for Lloyd→Frank + reliability).
- **Ralphs / TheRealReal:** just sign in on Lloyd's Chrome (no site-side change).
- **BlueBubbles / iMessage:** family Apple ID signed into the BlueBubbles server + Private API enabled (Lloyd's mini).
- **No new setup** for Azure / Slack / Brave / Graph — all ride the copied `.env`.

## Realistic tonight scope
- **Definitely:** Lloyd's mini fully live (daemon + restore + browser profile) and Frank's mini live + wired to Lloyd.
- **Maybe defer one night:** BlueBubbles/iMessage (fiddliest) and turning on Frank's breach monitor — neither blocks the core assistant; email + Slack carry the text channel meanwhile.
