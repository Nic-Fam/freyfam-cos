#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Upsert KEY=VALUE lines into an .env file, safely.
#
# Reads KEY=VALUE lines from STDIN. For each, any existing line for that key is
# removed and the new one appended; brand-new keys are appended; every other line
# in the file is preserved. Values are taken LITERALLY (no shell or sed
# interpretation), so secrets containing / + = are handled correctly — the thing
# that makes hand-editing or `sed` error-prone. Blank lines and #comments in the
# input are skipped.
#
#   ./deploy/set-env.sh [path-to-.env]     # default: ./.env
#
# Example (local):
#   ./deploy/set-env.sh <<'EOF'
#   COS_SPECIALIST_KEY_RESALE=abc123==
#   EOF
#
# Example (remote over Tailscale, from another machine):
#   ssh lloyd@lloyd 'cd ~/freyfam-cos && ./deploy/set-env.sh' <<'EOF'
#   COS_SPECIALIST_KEY_RESALE=abc123==
#   EOF
# =============================================================================

ENV_FILE=${1:-.env}
[ -f "$ENV_FILE" ] || touch "$ENV_FILE"

tmp=$(mktemp)
cp "$ENV_FILE" "$tmp"
changed=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|\#*) continue ;; esac   # skip blanks + comments
  key=${line%%=*}
  [ "$key" = "$line" ] && continue           # no '=' -> not a KEY=VALUE line
  # Drop any existing (uncommented) line for this key, then append the new one.
  grep -v -E "^[[:space:]]*${key}=" "$tmp" > "$tmp.2" || true
  mv "$tmp.2" "$tmp"
  printf '%s\n' "$line" >> "$tmp"
  echo "  set $key"
  changed=1
done

if [ "$changed" = 1 ]; then
  # Back up once, then swap in the updated file.
  cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s 2>/dev/null || echo prev)" 2>/dev/null || true
  mv "$tmp" "$ENV_FILE"
  echo "updated $ENV_FILE (backup written alongside)"
else
  rm -f "$tmp"
  echo "no KEY=VALUE lines on stdin; $ENV_FILE unchanged"
fi
