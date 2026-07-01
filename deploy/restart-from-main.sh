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
launchctl kickstart -k "gui/$(id -u)/com.freyfam.cos"
echo "kickstarted from $(git rev-parse --short HEAD)"
