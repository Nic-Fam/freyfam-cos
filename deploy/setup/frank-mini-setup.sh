#!/usr/bin/env bash
#
# One-shot setup for Frank (security specialist) on a Mac mini.
# Mirrors deploy/setup/frank-mac-mini.md, automated and idempotent.
#
# Run ON Frank's Mac mini, from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/Nic-Fam/freyfam-cos/main/deploy/setup/frank-mini-setup.sh | bash
# or, if you already have the repo:
#   bash deploy/setup/frank-mini-setup.sh
#
# Does NOT touch secrets you don't give it: ANTHROPIC_API_KEY and the shared
# function key are prompted for (or read from env), never committed.
#
# Honors these env vars if preset (otherwise prompts / defaults):
#   ANTHROPIC_API_KEY          inference key (sk-ant-...)
#   COS_SPECIALIST_LOCAL_KEY   shared secret; must match Lloyd's COS_SPECIALIST_KEY_SECURITY
#   PORT                       default 8787
#   FAMILY_TZ                  default America/Los_Angeles
#   REPO_DIR                   default ~/freyfam-cos
#   LOAD_LAUNCHD=1             also load the LaunchAgent at the end

set -euo pipefail

REPO_URL="https://github.com/Nic-Fam/freyfam-cos.git"
REPO_DIR="${REPO_DIR:-$HOME/freyfam-cos}"
PORT="${PORT:-8787}"
FAMILY_TZ="${FAMILY_TZ:-America/Los_Angeles}"

say()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "This is meant to run on Frank's Mac mini (macOS), not $(uname -s)."

# --- 1. Homebrew -------------------------------------------------------------
if ! command -v brew >/dev/null 2>&1; then
  say "Installing Homebrew (will prompt for your password)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
# Put brew on PATH for this run (Apple Silicon vs Intel).
if [[ -x /opt/homebrew/bin/brew ]]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
  BREW_PREFIX=/opt/homebrew
elif [[ -x /usr/local/bin/brew ]]; then
  eval "$(/usr/local/bin/brew shellenv)"
  BREW_PREFIX=/usr/local
else
  die "brew not found after install."
fi
# Persist brew on PATH for future shells (idempotent).
if ! grep -q 'brew shellenv' "$HOME/.zprofile" 2>/dev/null; then
  printf '\neval "$(%s/bin/brew shellenv)"\n' "$BREW_PREFIX" >> "$HOME/.zprofile"
fi

# --- 2. Node 22 --------------------------------------------------------------
say "Ensuring Node 22..."
brew list node@22 >/dev/null 2>&1 || brew install node@22
# node@22 is keg-only; put it first on PATH.
export PATH="$BREW_PREFIX/opt/node@22/bin:$PATH"
if ! grep -q 'opt/node@22/bin' "$HOME/.zprofile" 2>/dev/null; then
  printf 'export PATH="%s/opt/node@22/bin:$PATH"\n' "$BREW_PREFIX" >> "$HOME/.zprofile"
fi
NODE_BIN="$(command -v node)"
say "node $(node -v) at $NODE_BIN"
[[ "$(node -v)" == v22* ]] || die "node is not v22 (got $(node -v)). Check PATH ordering."

# --- 3. Code -----------------------------------------------------------------
if [[ -d "$REPO_DIR/.git" ]]; then
  say "Repo already at $REPO_DIR; pulling latest..."
  git -C "$REPO_DIR" pull --ff-only || warn "git pull skipped (local changes?)"
else
  say "Cloning into $REPO_DIR..."
  git clone "$REPO_URL" "$REPO_DIR"
fi
cd "$REPO_DIR"
say "npm install..."
npm install
say "Offline smoke test..."
node _smoke.mjs

# --- 4. .env -----------------------------------------------------------------
if [[ -f .env ]]; then
  warn ".env already exists; leaving it untouched. Verify it has COS_AGENT=security, PORT, the keys."
else
  say "Creating .env..."
  cp .env.example .env

  if [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
    read -r -p "Anthropic API key (sk-ant-..., inference key not admin): " ANTHROPIC_API_KEY
  fi
  if [[ -z "${COS_SPECIALIST_LOCAL_KEY:-}" ]]; then
    read -r -p "Shared function key [blank = generate one]: " COS_SPECIALIST_LOCAL_KEY
    if [[ -z "$COS_SPECIALIST_LOCAL_KEY" ]]; then
      COS_SPECIALIST_LOCAL_KEY="$(openssl rand -hex 32)"
      warn "Generated key (put this in Lloyd's .env as COS_SPECIALIST_KEY_SECURITY):"
      printf '    %s\n' "$COS_SPECIALIST_LOCAL_KEY"
    fi
  fi

  # Append Frank's settings; .env.example ships these blank/commented.
  {
    echo ""
    echo "# --- Frank (security) local specialist; added by frank-mini-setup.sh ---"
    echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
    echo "COS_AGENT=security"
    echo "COS_SPECIALIST_LOCAL_KEY=$COS_SPECIALIST_LOCAL_KEY"
    echo "PORT=$PORT"
    echo "FAMILY_TZ=$FAMILY_TZ"
  } >> .env
  say ".env written (gitignored)."
fi

# --- 5. Seed (optional; seed sources are out-of-band / gitignored) -----------
say "Seeding shared starter facts..."
npm run seed || warn "npm run seed failed; continue and seed later."
for extra in data/seed-family-identity.mjs; do
  [[ -f "$extra" ]] && node "$extra" || true
done
if [[ -f data/seed-family-domains.json ]]; then
  npm run seed data/seed-family-domains.json || true
else
  warn "data/seed-family-domains.json not present (transfer it out-of-band to surface security-scoped notes)."
fi

# --- 6. launchd plist (generated with real paths) ----------------------------
PLIST="$HOME/Library/LaunchAgents/com.freyfam.frank.plist"
# Read the key back from .env so the plist matches what's live.
LIVE_KEY="$(grep -E '^COS_SPECIALIST_LOCAL_KEY=' .env | head -1 | cut -d= -f2-)"
say "Writing LaunchAgent -> $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.freyfam.frank</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-is</string>
        <string>$NODE_BIN</string>
        <string>$REPO_DIR/deploy/specialists/local-server.mjs</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>COS_AGENT</key>                <string>security</string>
        <key>PORT</key>                     <string>$PORT</string>
        <key>COS_SPECIALIST_LOCAL_KEY</key> <string>$LIVE_KEY</string>
    </dict>
    <key>RunAtLoad</key>  <true/>
    <key>KeepAlive</key>  <true/>
    <key>StandardOutPath</key>  <string>$REPO_DIR/frank.out.log</string>
    <key>StandardErrorPath</key> <string>$REPO_DIR/frank.err.log</string>
</dict>
</plist>
PLIST_EOF

# --- 7. Optionally load it ---------------------------------------------------
if [[ "${LOAD_LAUNCHD:-0}" == "1" ]]; then
  say "Loading LaunchAgent..."
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  sleep 1
  say "Health check..."
  curl -fsS -X POST "http://localhost:$PORT/" \
    -H "content-type: application/json" \
    -H "x-functions-key: $LIVE_KEY" \
    -d '{"agent":"security","task":"Reply with the single word: ok"}' \
    && printf '\n' || warn "Health check failed; see $REPO_DIR/frank.err.log"
else
  cat <<DONE

Setup complete. To start Frank under launchd:
  launchctl load -w "$PLIST"
  sudo pmset -c disablesleep 1     # optional: lid-closed operation on power

Or run in the foreground first to watch logs:
  cd "$REPO_DIR" && npm run specialist

Then wire Lloyd (on Lloyd's box .env):
  COS_SPECIALIST_MODE=remote
  COS_SPECIALIST_URL_SECURITY=http://frank.local:8787/
  COS_SPECIALIST_KEY_SECURITY=<the same shared key>
DONE
fi
