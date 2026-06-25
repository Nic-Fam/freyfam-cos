# Safe restart runbook (Lloyd + specialists)

The exact procedure to restart any of the launchd-managed boxes after a code pull
or `.env` change. A long-running Node process caches imported modules, so new code
does NOT take effect until the process restarts. This is the full sequence: a
pre-flight check, the restart, then verification. Don't skip the pre-flight or the
verify step — "kickstart and walk away" is how a restart silently drops in-flight
work or comes back broken.

Labels per box:

| Box   | launchd label      | entry point                                  |
|-------|--------------------|----------------------------------------------|
| Lloyd | `com.freyfam.cos`  | `src/daemon.js`                              |
| Steve | `com.freyfam.steve`| `deploy/specialists/local-server.mjs`        |
| Frank | `com.freyfam.frank`| `deploy/specialists/local-server.mjs`        |

Set `LABEL` once, then every command below is copy-paste:

```bash
LABEL=com.freyfam.steve     # or com.freyfam.cos / com.freyfam.frank
```

---

## 1. Pre-flight (do NOT skip)

**ALWAYS restart from `main`.** Multiple sessions share this one working directory
and switch its branch (resale, prompt-cache, rx-sync, ...). The daemon runs whatever
is on disk at restart time, so restarting while the worktree sits on a feature branch
deploys that branch's in-progress code, not merged `main`. Before anything else:

```bash
git checkout main && git pull --ff-only
git rev-parse HEAD; git rev-parse origin/main   # must match before you restart
```

If the tree is dirty (a session left uncommitted work), do NOT stash/discard it —
that's someone else's work. Coordinate, or restart later. Only restart from a clean
`main` synced to `origin/main`.

**On Lloyd (`com.freyfam.cos`) — check for staged approvals next.** Restarting
mid-flight drops any pending confirmation, so an outbound action the family already
approved (or is about to) is lost silently. Inspect it; never clear it blindly:

```bash
cat data/pending-approvals.json     # expect {}  -> safe to restart
```

If it is anything other than `{}`, a confirmation is in flight. Let it resolve (or
confirm with the family) before restarting. Do not delete the file to "clean up."

**On a specialist (Steve / Frank) — confirm no in-flight delegation.** Specialists
hold no approval state (the confirmation gate lives only on Lloyd), so the only risk
is killing a task Lloyd is mid-delegation on. That is recoverable — Lloyd surfaces a
"couldn't reach the X specialist" and can retry — but avoid restarting during a known
long dev/security task if you can. A quick glance at the log shows whether one is
running:

```bash
tail -5 steve.err.log steve.out.log   # frank.* on Frank; quiet == idle
```

---

## 2. Confirm it's launchd-managed, then restart

```bash
git branch --show-current             # MUST read "main" (see step 1) before restarting Lloyd
launchctl list | grep "$LABEL"        # shows <pid> <status> <label> if managed
launchctl kickstart -k "gui/$(id -u)/$LABEL"   # -k = kill then restart
```

`kickstart -k` is the right tool: it stops the current process and starts a fresh
one under the same job, so new code loads and `KeepAlive` is preserved. If the job
is NOT listed (someone ran it by hand, not under launchd), restart it the way it was
started instead — for a hand-run specialist that's Ctrl-C and `npm run specialist`.

---

## 3. Verify it actually came back

```bash
# new PID present (and different from before):
pgrep -fl "src/daemon.js"                       # Lloyd
pgrep -fl "deploy/specialists/local-server.mjs" # Steve / Frank

# startup lines in the log, and NO new errors:
tail -8 cos.out.log ; tail -5 cos.err.log       # Lloyd  (steve.* / frank.* otherwise)
```

What "healthy" looks like:

- **Lloyd:** `Frey Family Chief of Staff starting`, `slack socket mode connected`,
  `queue consuming`, `heartbeat scheduled`.
- **Steve / Frank:** `local specialist listening { agent: '<dev|security>', ... authed: true }`.

Then **read the error-log timestamps**: lines dated *before* the restart are old
history, not a new failure. Only a line stamped *after* your restart is a real
post-restart error. (When debugging the Slack image bug we saw three old "Could not
process image" lines linger in `cos.err.log` after a clean restart — they predated
the restart and were harmless.)

For a specialist, the definitive check is the contract still answers — run the
`curl` health probe from that box's setup doc (returns `{"text":"..."}`; wrong agent
→ 403, bad key → 401).

---

## 4. Stop / start / rollback

```bash
launchctl unload ~/Library/LaunchAgents/$LABEL.plist   # stop
launchctl load   ~/Library/LaunchAgents/$LABEL.plist   # start
```

If a restart picked up a bad pull, check out the previous commit and `kickstart -k`
again — state lives in `data/` and (for Lloyd) the Azure queue, so a code rollback
loses no data.
