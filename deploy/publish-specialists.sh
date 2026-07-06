#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Deploy the specialist code to the Function Apps created by
# provision-specialists.sh, then print the exact .env block to paste on Lloyd's
# side to cut over.
#
# The deployable bundle = the Function host files (deploy/specialists/*) PLUS the
# shared repo src/ (the runner + its deps), assembled in a temp dir so we never
# commit a duplicated copy of src/. The same bundle deploys to every specialist;
# the COS_AGENT app setting (set at provision time) is what specializes it.
#
# Requires: az CLI (logged in), Azure Functions Core Tools (`func`), npm.
# =============================================================================

RG=${RG:-freyfam-cos-specialists}
APP_PREFIX=${APP_PREFIX:-freyfam-cos}
# Azure-hosted specialists ONLY (see provision-specialists.sh). security (Frank)
# and dev (Steve) run locally on Macs via deploy/specialists/local-server.mjs.
AGENTS=${AGENTS:-finance resale chef}

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
FUNC_SRC="$REPO_ROOT/deploy/specialists"

command -v func >/dev/null || { echo "Azure Functions Core Tools (func) required: https://aka.ms/func-core-tools"; exit 1; }
command -v az   >/dev/null || { echo "Azure CLI (az) required"; exit 1; }

# --- assemble the bundle (NO local node_modules) ---
# Ship source only and let Azure build node_modules on Linux (--build remote).
# Shipping a macOS-built node_modules to a Linux Consumption host is the original
# sin that crash-looped the host (503). Source comes from the committed branch so
# a half-saved working tree can't leak into a deploy.
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
cp "$FUNC_SRC/host.json" "$FUNC_SRC/package.json" "$BUILD/"
mkdir -p "$BUILD/app"
cp "$FUNC_SRC/app/specialist.mjs" "$BUILD/app/"
git -C "$REPO_ROOT" archive HEAD src | tar -x -C "$BUILD"
echo "bundle assembled, source-only ($BUILD)"

# --- deploy to each specialist app with a remote Linux build ---
PUBLISH_WARN=0
for AGENT in $AGENTS; do
  APP="${APP_PREFIX}-${AGENT}"
  echo "=== publishing -> $APP (remote build) ==="
  ( cd "$BUILD" && func azure functionapp publish "$APP" --javascript --build remote )
  # Verify the host actually REGISTERED the function. An empty list means the
  # deploy landed but no function is served (every call 404s) — the silent failure
  # that hid a broken provision for weeks. Surface it here instead of at runtime.
  FN_COUNT=$(az functionapp function list -g "$RG" -n "$APP" --query "length(@)" -o tsv 2>/dev/null || echo 0)
  if [ "${FN_COUNT:-0}" = "0" ]; then
    echo "  !! WARNING: $APP registered 0 functions -> it will 404. Likely a non-Flex app"
    echo "     (re-run provision-specialists.sh) or missing EnableWorkerIndexing."
    PUBLISH_WARN=1
  else
    echo "  ok: $APP serving $FN_COUNT function(s)"
  fi
done
if [ "$PUBLISH_WARN" = 1 ]; then
  echo
  echo "One or more apps registered NO functions — fix those before relying on them (see warnings above)."
fi

# --- print the Lloyd-side .env block ---
echo
echo "# ===== paste into Lloyd's .env, then restart the daemon ====="
echo "COS_SPECIALIST_MODE=remote"
for AGENT in $AGENTS; do
  APP="${APP_PREFIX}-${AGENT}"
  UP=$(echo "$AGENT" | tr '[:lower:]' '[:upper:]')
  URL="https://${APP}.azurewebsites.net/api/specialist"
  KEY=$(az functionapp function keys list -g "$RG" -n "$APP" --function-name specialist --query default -o tsv 2>/dev/null || echo "")
  echo "COS_SPECIALIST_URL_${UP}=${URL}"
  echo "COS_SPECIALIST_KEY_${UP}=${KEY}"
done
echo "# ============================================================"
echo
echo "Cutover is per-agent: paste only the specialists you want remote; any agent"
echo "without a URL stays in-process. Roll back by setting COS_SPECIALIST_MODE=local."
