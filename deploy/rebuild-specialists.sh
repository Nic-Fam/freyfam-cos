#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# One-shot teardown + clean rebuild of the Azure specialist tier.
#
# Use when the resource group is in a bad/mixed state (classic stubs that 404,
# leftover *-flex or unused security/dev apps, orphan App Service Plans) — i.e.
# the exact mess that leaves specialists unreachable. This DELETES the whole
# resource group and rebuilds finance/resale/chef fresh via the (self-verifying)
# provision + publish scripts.
#
# Safe to nuke: the specialist Azure tables are per-agent scratch (memory/
# decisions) and Lloyd's real brain lives locally, not here. security (Frank) and
# dev (Steve) run on Macs via local-server.mjs — any Azure apps by those names are
# unused leftovers.
#
# Requires: az (logged in, Flex-capable), func, npm. ANTHROPIC_API_KEY in the env.
#   ANTHROPIC_API_KEY=<key> ./deploy/rebuild-specialists.sh
#   ANTHROPIC_API_KEY=<key> LOCATION=westus2 ./deploy/rebuild-specialists.sh   # different region
# =============================================================================

RG=${RG:-freyfam-cos-specialists}
LOCATION=${LOCATION:-eastus}
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY (the inference key) before running}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "About to DELETE resource group '$RG' (everything in it) and rebuild the"
echo "finance/resale/chef specialists fresh in '$LOCATION'."
printf "Type the resource group name to confirm: "
read -r CONFIRM
[ "$CONFIRM" = "$RG" ] || { echo "names don't match — aborted, nothing changed."; exit 1; }

echo "=== deleting $RG (this takes a few minutes) ==="
az group delete -n "$RG" --yes

# Fresh region => fresh storage account (don't carry over a name from a deleted RG).
unset DATA_STORAGE
echo "=== provisioning fresh in $LOCATION ==="
RG="$RG" LOCATION="$LOCATION" bash "$HERE/provision-specialists.sh"
echo "=== publishing code ==="
RG="$RG" bash "$HERE/publish-specialists.sh"

echo
echo "Done. The publish step printed the Lloyd .env block above — paste the"
echo "COS_SPECIALIST_URL_*/KEY_* lines into Lloyd's .env and restart him."
