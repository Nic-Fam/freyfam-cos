#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Provision the Azure side of the specialist split (CONFIRMED topology, see
# CLAUDE.md). One Functions Consumption app PER specialist, each with its OWN
# system-assigned managed identity scoped to its OWN data Table. That per-app
# identity + per-table RBAC is the isolation mechanism - NOT warm compute.
#
# Idempotent-ish: re-running is safe (creates are skipped if they exist).
# Requires: az CLI, logged in (`az login`), correct subscription selected.
# Run `deploy/publish-specialists.sh` AFTER this to deploy code + print .env.
#
# Override any of these via env, e.g.  LOCATION=westus2 RG=my-rg bash thisscript
# =============================================================================

LOCATION=${LOCATION:-eastus}
RG=${RG:-freyfam-cos-specialists}
APP_PREFIX=${APP_PREFIX:-freyfam-cos}
NODE_VERSION=${NODE_VERSION:-22}                 # verified on Flex Consumption; 20 is EOL
# Azure-hosted specialists ONLY. Per the confirmed topology (see CLAUDE.md):
# Lloyd + security (Frank) run on Mac minis and dev (Steve) on a local MacBook,
# so they are NOT provisioned in Azure - they run via deploy/specialists/local-server.mjs
# on that hardware. Override AGENTS to add/remove apps.
AGENTS=${AGENTS:-finance resale chef}
# Storage account name: globally unique, 3-24 chars, lowercase alnum only. On a
# RE-provision we must REUSE the RG's existing account, not invent a new random
# one (a fresh account strands the apps' runtime + data). Prefer an existing one;
# fall back to a new unique name on a first run.
DATA_STORAGE=${DATA_STORAGE:-$(az storage account list -g "$RG" --query "[0].name" -o tsv 2>/dev/null || true)}
DATA_STORAGE=${DATA_STORAGE:-freyfamcosdata$RANDOM}
# The inference key lives in Key Vault, NOT in plain-text app settings. Each app
# reads it through a Key Vault reference using its own managed identity.
#   ANTHROPIC_API_KEY set   -> written to the vault (first run, or rotating the key)
#   ANTHROPIC_API_KEY unset -> the secret must already be in the vault
KEY_VAULT=${KEY_VAULT:-${APP_PREFIX}-kv}
SECRET_NAME=anthropic-api-key

# Preflight: this recipe REQUIRES a Flex Consumption-capable Azure CLI. A stale az
# silently creates plain-Linux apps with NO runtime (functionAppConfig=null) that
# never register a function and 404 forever (the exact failure that stranded the
# first provisioning). Fail early with a clear message instead of leaving stubs.
if ! az functionapp create --help 2>/dev/null | grep -q -- '--flexconsumption-location'; then
  echo "ERROR: this Azure CLI is too old for Flex Consumption (--flexconsumption-location)."
  echo "Upgrade it ('az upgrade', or Homebrew: 'brew upgrade azure-cli'), then re-run."
  exit 1
fi

# Read a Flex app's runtime name (e.g. "node"), or empty if absent/not-Flex. We go
# straight to the ARM resource at a pinned recent API version because `az functionapp
# show` on some CLI builds (seen on 2.79.0) uses a stale API version that returns a
# null functionAppConfig for perfectly healthy Flex apps — a false negative that
# aborted provisioning even though the app was Running. This is the source of truth.
flex_runtime() {  # $1 = app name
  az resource show -g "$RG" --resource-type Microsoft.Web/sites -n "$1" \
    --api-version 2023-12-01 \
    --query "properties.functionAppConfig.runtime.name" -o tsv 2>/dev/null || true
}

SUB=$(az account show --query id -o tsv)
echo "Subscription : $SUB"
echo "Resource grp : $RG ($LOCATION)"
echo "Data storage : $DATA_STORAGE"
echo "Specialists  : $AGENTS"
echo

az group create -n "$RG" -l "$LOCATION" -o none

# One storage account holds the runtime + one data Table per specialist. Data
# isolation comes from per-table RBAC below, not from separate accounts. For
# stronger isolation, give each specialist its own account (set DATA_STORAGE in
# a loop) - overkill at household scale.
az storage account create -n "$DATA_STORAGE" -g "$RG" -l "$LOCATION" \
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
  --allow-blob-public-access false -o none
echo "storage account ready"

# Key Vault (RBAC mode). It lives in this RG, so rebuild-specialists.sh deleting
# the RG soft-deletes it and reserves the name for 90 days: recover it instead of
# failing on create.
if ! az keyvault show -n "$KEY_VAULT" -o none 2>/dev/null; then
  if az keyvault show-deleted -n "$KEY_VAULT" -o none 2>/dev/null; then
    echo "recovering soft-deleted vault $KEY_VAULT"
    az keyvault recover -n "$KEY_VAULT" -o none
  else
    az keyvault create -n "$KEY_VAULT" -g "$RG" -l "$LOCATION" \
      --enable-rbac-authorization true --retention-days 90 -o none
  fi
fi
KV_ID=$(az keyvault show -n "$KEY_VAULT" --query id -o tsv)
SECRET_SCOPE="$KV_ID/secrets/$SECRET_NAME"
# The person running this needs to write secrets (skipped for a service principal).
ME=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
if [ -n "$ME" ]; then
  az role assignment create --assignee-object-id "$ME" --assignee-principal-type User \
    --role "Key Vault Secrets Officer" --scope "$KV_ID" -o none 2>/dev/null || true
fi
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  # Via a temp file so the key never shows up in the process list. Retry: a
  # fresh role assignment takes a minute or two to reach the vault.
  KEY_FILE=$(mktemp); trap 'rm -f "$KEY_FILE"' EXIT
  printf '%s' "$ANTHROPIC_API_KEY" > "$KEY_FILE"
  for attempt in 1 2 3 4 5 6 7 8; do
    if az keyvault secret set --vault-name "$KEY_VAULT" -n "$SECRET_NAME" \
         --file "$KEY_FILE" --encoding utf-8 -o none 2>/dev/null; then
      break
    fi
    [ "$attempt" = 8 ] && { echo "ERROR: could not write $SECRET_NAME to $KEY_VAULT"; exit 1; }
    echo "  vault write attempt $attempt failed (role replicating); retry in 15s"
    sleep 15
  done
  rm -f "$KEY_FILE"
  echo "inference key stored in $KEY_VAULT/$SECRET_NAME"
elif ! az keyvault secret show --vault-name "$KEY_VAULT" -n "$SECRET_NAME" -o none 2>/dev/null; then
  echo "ERROR: $SECRET_NAME is not in $KEY_VAULT. Set ANTHROPIC_API_KEY and re-run to store it."
  exit 1
fi
# Versionless URI: a rotated key is picked up without touching the apps.
KEY_REF="@Microsoft.KeyVault(SecretUri=https://${KEY_VAULT}.vault.azure.net/secrets/${SECRET_NAME}/)"

for AGENT in $AGENTS; do
  APP="${APP_PREFIX}-${AGENT}"
  TABLE="brain${AGENT}"   # alnum only; per-specialist memory + decision log

  echo "=== $AGENT  ->  app:$APP  table:$TABLE ==="

  az storage table create --name "$TABLE" --account-name "$DATA_STORAGE" \
    --auth-mode login -o none

  # Flex Consumption = scale-to-zero with a healthy v4 host. (Classic Linux
  # Consumption / --consumption-plan-location was tried first and its host would
  # not start in this sub/region: every app 503'd, including an undeployed one.
  # Flex fixed it. Flex is Linux-only and always Functions v4, so --os-type and
  # --functions-version are implicit.) System-assigned identity per app.
  #
  # An existing app can't have its plan type converted in place: if one is present
  # but is NOT Flex (functionAppConfig.runtime unset — a broken stub from an older
  # attempt), delete it so we recreate cleanly. A healthy Flex app is left as-is.
  if az functionapp show -n "$APP" -g "$RG" -o none 2>/dev/null; then
    RT=$(flex_runtime "$APP")
    if [ -n "$RT" ]; then
      echo "  $APP already Flex ($RT); skipping create"
    else
      echo "  $APP exists but is NOT Flex (broken stub) -> deleting to recreate"
      az functionapp delete -n "$APP" -g "$RG" -o none
      RT=""
    fi
  else
    RT=""
  fi
  if [ -z "$RT" ]; then
    # --disable-app-insights: the specialists don't use App Insights telemetry, and
    # letting az auto-create it fails ("Error while trying to create and configure an
    # Application Insights...") when the Microsoft.Insights provider isn't registered
    # in the sub. That failure is benign but noisy; skipping it removes the failure mode.
    az functionapp create -n "$APP" -g "$RG" \
      --storage-account "$DATA_STORAGE" \
      --flexconsumption-location "$LOCATION" \
      --runtime node --runtime-version "$NODE_VERSION" \
      --disable-app-insights true \
      --assign-identity '[system]' -o none
    # Assert Flex actually took. A null runtime here means create silently produced
    # a dead classic app again — abort loudly rather than move on and 404 later.
    RT_CHECK=$(flex_runtime "$APP")
    if [ -z "$RT_CHECK" ]; then
      echo "ERROR: $APP did not come up as Flex Consumption (no runtime). Check 'az upgrade' and that Flex is offered in $LOCATION."
      exit 1
    fi
  fi

  PRINCIPAL=$(az functionapp identity show -n "$APP" -g "$RG" --query principalId -o tsv)
  TABLE_ENDPOINT="https://${DATA_STORAGE}.table.core.windows.net"

  # App settings: pin the agent, reference the inference key in Key Vault, point
  # at the data Table. Both the key and the Table are read via the app's managed
  # identity, so no secret sits in the app settings.
  # EnableWorkerIndexing is REQUIRED for the v4 Node programming model: without
  # it the host never discovers the code-defined function (publish reports
  # "Error calling sync triggers" and the function list stays empty).
  az functionapp config appsettings set -n "$APP" -g "$RG" -o none --settings \
    COS_AGENT="$AGENT" \
    ANTHROPIC_API_KEY="$KEY_REF" \
    COS_TABLE_ENDPOINT="$TABLE_ENDPOINT" \
    COS_TABLE_NAME="$TABLE" \
    AzureWebJobsFeatureFlags="EnableWorkerIndexing"

  # Grant THIS app's identity data access to ONLY its own table. This is the
  # isolation boundary: finance's identity cannot read chef's table.
  # Use --assignee-object-id + principal-type to SKIP the AAD graph lookup that
  # races a freshly created managed identity; retry briefly for replication lag.
  TABLE_SCOPE="/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Storage/storageAccounts/${DATA_STORAGE}/tableServices/default/tables/${TABLE}"
  for attempt in 1 2 3 4 5 6; do
    if az role assignment create --assignee-object-id "$PRINCIPAL" \
         --assignee-principal-type ServicePrincipal \
         --role "Storage Table Data Contributor" --scope "$TABLE_SCOPE" -o none 2>/dev/null; then
      break
    fi
    echo "  role-assign attempt $attempt failed (identity replicating); retry in 10s"
    sleep 10
  done
  # Let this app read the ONE inference-key secret (not the whole vault).
  for attempt in 1 2 3 4 5 6; do
    if az role assignment create --assignee-object-id "$PRINCIPAL" \
         --assignee-principal-type ServicePrincipal \
         --role "Key Vault Secrets User" --scope "$SECRET_SCOPE" -o none 2>/dev/null; then
      break
    fi
    echo "  key-vault role attempt $attempt failed (identity replicating); retry in 10s"
    sleep 10
  done
  echo "  identity $PRINCIPAL scoped to $TABLE + $SECRET_NAME only"
done

echo
echo "Infra ready. Next:"
echo "  bash deploy/publish-specialists.sh   # deploy code + print the .env block"
