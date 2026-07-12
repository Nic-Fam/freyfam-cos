#!/bin/bash
# Main-safe restart for the SOLE live Lloyd on the Mac mini. Run nightly (4am) by
# launchd (com.freyfam.cos.restart) and usable by hand for a deploy.
#
# The daemon's checkout (/Users/lloyd/freyfam-cos) is ONLY ever on main -- dev
# happens elsewhere and is pushed to origin/main -- so `reset --hard origin/main`
# is safe and picks up the day's merged code while clearing wedged in-memory
# state. State + .env (gitignored; e.g. COS_EMAIL_RECONCILE_ENABLED) persist
# across the reset.
#
# HEALTH GATE (why this is not a plain kickstart): after pulling, we load the
# daemon's FULL import graph via `node src/daemon.js --preflight` (exits 0 iff all
# deps + imports + config actually load, then quits before starting anything). A
# bare `node --check` only parses SYNTAX -- it would pass a checkout with a missing
# dependency or broken import and let the daemon crash-loop. If preflight fails we
# roll back to the prior commit so the only Lloyd never boots on unloadable code.
# (This gate exists because a committed node_modules symlink once passed the old
# syntax-only check and took Lloyd down -- see deploy notes / commit 40a1f11.)
#
# The canonical copy lives at /Users/lloyd/cos-ops/restart-from-main.sh on the
# mini (referenced by absolute path in the plist); this repo copy is the source of
# truth to redeploy it from.
set -uo pipefail
# launchd does NOT inherit the shell PATH; add the mini's Homebrew node@22.
# git + launchctl are in default system paths.
export PATH="/usr/local/opt/node@22/bin:$PATH"
LIVE=/Users/lloyd/freyfam-cos
echo "=== nightly restart $(date) ==="
cd "$LIVE" || { echo "cd freyfam-cos failed"; exit 1; }
PREV=$(git rev-parse --short HEAD)
if git fetch --quiet origin main && git reset --hard --quiet origin/main; then
  npm install --no-audit --no-fund --silent || echo "WARN: npm hiccup"
  if ! node src/daemon.js --preflight; then
    echo "WARN: daemon failed preflight on $(git rev-parse --short HEAD); rolling back to $PREV"
    git reset --hard --quiet "$PREV"
    npm install --no-audit --no-fund --silent || echo "WARN: npm hiccup (rollback)"
    node src/daemon.js --preflight || echo "WARN: rollback commit ALSO fails preflight; kickstarting anyway"
  fi
else
  echo "WARN: git refresh failed; restarting current code"
fi
UID_N=$(id -u)
DOMAIN="gui/$UID_N/com.freyfam.cos"
PLIST="$HOME/Library/LaunchAgents/com.freyfam.cos.plist"
SHA=$(git rev-parse --short HEAD)

# Kill any stray/orphan daemon first: a hand-started `node src/daemon.js` left over
# an SSH session double-binds :8790/:1235 -> EADDRINUSE -> launchd crash-loops.
# launchd re-spawns the managed one below. (Mirrors Frank's orphan guard, 2026-07-12.)
pkill -f "src/daemon.js" 2>/dev/null && sleep 1

# Bootstrap the service if it is not loaded. A prior bootout leaves `kickstart` with
# no service to find -> it errors but the old script still printed "kickstarted",
# SILENTLY leaving Lloyd DOWN (happened 2026-07-12). Self-heal instead.
launchctl print "$DOMAIN" >/dev/null 2>&1 || launchctl bootstrap "gui/$UID_N" "$PLIST"
launchctl kickstart -k "$DOMAIN"

# Never claim success on a failed start: verify a live PID, fail LOUD otherwise so a
# broken deploy is visible (nonzero exit) instead of a quietly-down sole Lloyd.
sleep 4
PID=$(pgrep -f "src/daemon.js" | head -1)
if [ -n "$PID" ]; then
  echo "restart OK: daemon up on $SHA (pid $PID)"
else
  echo "RESTART FAILED: no daemon process after kickstart on $SHA -- try: launchctl bootstrap gui/$UID_N $PLIST" >&2
  exit 1
fi
