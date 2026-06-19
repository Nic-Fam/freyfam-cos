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
AGENTS=${AGENTS:-finance dev resale chef security}
# Storage account name: globally unique, 3-24 chars, lowercase alnum only.
DATA_STORAGE=${DATA_STORAGE:-freyfamcosdata$(echo $RANDOM)}
: "${ANTHROPIC_API_KEY:?set ANTHROPIC_API_KEY (the inference key) before running}"

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
  az functionapp create -n "$APP" -g "$RG" \
    --storage-account "$DATA_STORAGE" \
    --flexconsumption-location "$LOCATION" \
    --runtime node --runtime-version "$NODE_VERSION" \
    --assign-identity '[system]' -o none

  PRINCIPAL=$(az functionapp identity show -n "$APP" -g "$RG" --query principalId -o tsv)
  TABLE_ENDPOINT="https://${DATA_STORAGE}.table.core.windows.net"

  # App settings: pin the agent, hand over the inference key, point at the data
  # Table. The specialist reads the Table via its managed identity (no secret).
  # EnableWorkerIndexing is REQUIRED for the v4 Node programming model: without
  # it the host never discovers the code-defined function (publish reports
  # "Error calling sync triggers" and the function list stays empty).
  az functionapp config appsettings set -n "$APP" -g "$RG" -o none --settings \
    COS_AGENT="$AGENT" \
    ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
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
  echo "  identity $PRINCIPAL scoped to $TABLE only"
done

echo
echo "Infra ready. Next:"
echo "  bash deploy/publish-specialists.sh   # deploy code + print the .env block"
