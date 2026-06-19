#!/usr/bin/env bash
#
# Belt-and-suspenders Azure cost alert that fires from Azure's side, so you get
# warned even when the MacBook daemon is asleep/offline. This complements (does
# NOT replace) the daemon's hourly check in src/cost.js.
#
# It creates:
#   1. an action group with an SMS receiver (your phone), and
#   2. a subscription budget that texts you at 80% and 100% of $100/month, plus
#      a forecasted-to-exceed alert so you hear about it BEFORE you blow past it.
#
# Tradeoff vs the daemon: Azure re-evaluates budgets roughly every 8-24h (not
# hourly) and SMS goes through Azure Monitor, not Twilio. That's the point --
# it's an independent path that doesn't depend on this repo running.
#
# Prereqs:
#   - az CLI logged in:  az login
#   - Your account needs WRITE access to create these (Cost Management
#     Contributor + Monitoring Contributor, or Owner/Contributor). Note this is
#     MORE than the read-only "Cost Management Reader" the daemon's SP uses.
#
# Run:
#   1. Edit the four variables below.
#   2. bash deploy/azure-budget.sh
#
set -euo pipefail

# ---- edit these ----------------------------------------------------------
SUBSCRIPTION_ID="00000000-0000-0000-0000-000000000000"
PHONE_NUMBER="5551234567"     # digits only, no +; matches OWNER_PHONE
PHONE_COUNTRY_CODE="1"        # 1 = US/Canada
AMOUNT=100                    # monthly budget in your billing currency (USD)
# --------------------------------------------------------------------------

RG="cos-billing-alerts"            # small RG just to hold the action group
LOCATION="eastus"                  # action groups are global; RG location is cosmetic
ACTION_GROUP="cos-cost-alerts"
BUDGET_NAME="cos-monthly-budget"
API_VERSION="2023-11-01"

echo "==> Targeting subscription $SUBSCRIPTION_ID"
az account set --subscription "$SUBSCRIPTION_ID"

echo "==> Ensuring resource group $RG"
az group create --name "$RG" --location "$LOCATION" --output none

echo "==> Creating action group $ACTION_GROUP (SMS -> +$PHONE_COUNTRY_CODE $PHONE_NUMBER)"
az monitor action-group create \
  --resource-group "$RG" \
  --name "$ACTION_GROUP" \
  --short-name "coscost" \
  --sms-receiver name=owner country-code="$PHONE_COUNTRY_CODE" phone-number="$PHONE_NUMBER" \
  --output none

ACTION_GROUP_ID=$(az monitor action-group show \
  --resource-group "$RG" --name "$ACTION_GROUP" --query id --output tsv)
echo "    action group: $ACTION_GROUP_ID"

# Budget thresholds are PERCENT of AMOUNT. With AMOUNT=100: 80 -> $80, 100 -> $100.
# Forecasted alerts fire when Azure PROJECTS you'll exceed the threshold this cycle.
START_DATE=$(date -u +%Y-%m-01T00:00:00Z)
END_DATE="2032-01-01T00:00:00Z"

echo "==> Creating budget $BUDGET_NAME (\$$AMOUNT/month) wired to the action group"
az rest --method put \
  --url "https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/providers/Microsoft.Consumption/budgets/$BUDGET_NAME?api-version=$API_VERSION" \
  --body "$(cat <<JSON
{
  "properties": {
    "category": "Cost",
    "amount": $AMOUNT,
    "timeGrain": "Monthly",
    "timePeriod": { "startDate": "$START_DATE", "endDate": "$END_DATE" },
    "notifications": {
      "actual_80_percent": {
        "enabled": true,
        "operator": "GreaterThanOrEqualTo",
        "threshold": 80,
        "thresholdType": "Actual",
        "contactGroups": ["$ACTION_GROUP_ID"]
      },
      "actual_100_percent": {
        "enabled": true,
        "operator": "GreaterThanOrEqualTo",
        "threshold": 100,
        "thresholdType": "Actual",
        "contactGroups": ["$ACTION_GROUP_ID"]
      },
      "forecasted_100_percent": {
        "enabled": true,
        "operator": "GreaterThanOrEqualTo",
        "threshold": 100,
        "thresholdType": "Forecasted",
        "contactGroups": ["$ACTION_GROUP_ID"]
      }
    }
  }
}
JSON
)" \
  --output none

echo "==> Done. Verify in the portal: Cost Management + Billing -> Budgets -> $BUDGET_NAME"
echo "    Test the SMS path:  az monitor action-group test-notifications create \\"
echo "      --action-group-name $ACTION_GROUP --resource-group $RG --alert-type budget"
