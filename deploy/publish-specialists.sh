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
AGENTS=${AGENTS:-finance dev resale chef security}

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
FUNC_SRC="$REPO_ROOT/deploy/specialists"

command -v func >/dev/null || { echo "Azure Functions Core Tools (func) required: https://aka.ms/func-core-tools"; exit 1; }
command -v az   >/dev/null || { echo "Azure CLI (az) required"; exit 1; }

# --- assemble the bundle ---
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
cp "$FUNC_SRC/host.json" "$FUNC_SRC/package.json" "$BUILD/"
mkdir -p "$BUILD/app"
cp "$FUNC_SRC/app/specialist.mjs" "$BUILD/app/"
cp -R "$REPO_ROOT/src" "$BUILD/src"
( cd "$BUILD" && npm install --omit=dev --no-audit --no-fund --silent )
echo "bundle assembled ($BUILD)"

# --- deploy the same bundle to each specialist app ---
for AGENT in $AGENTS; do
  APP="${APP_PREFIX}-${AGENT}"
  echo "=== publishing -> $APP ==="
  ( cd "$BUILD" && func azure functionapp publish "$APP" --javascript )
done

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
