#!/usr/bin/env bash
# Verifies BUG-033 — Flutter models map from actual API field names
set -eu

PROVIDER="customer/lib/providers/contributor_provider.dart"
MODEL="customer/lib/models/contributor.dart"

ISSUES=0

# Check provider unwraps dashboard wrapper
if ! grep -q "\['dashboard'\]" "$PROVIDER"; then
  echo "FAIL: provider does not unwrap response['dashboard']"
  ISSUES=$((ISSUES + 1))
fi

# Check ContributorDesign maps productTitle
if ! grep -q "productTitle" "$MODEL"; then
  echo "FAIL: model does not map productTitle"
  ISSUES=$((ISSUES + 1))
fi

# Check ContributorDesign maps salesCount
if ! grep -q "salesCount" "$MODEL"; then
  echo "FAIL: model does not map salesCount"
  ISSUES=$((ISSUES + 1))
fi

# Check ContributorMilestone maps milestoneType
if ! grep -q "milestoneType" "$MODEL"; then
  echo "FAIL: model does not map milestoneType"
  ISSUES=$((ISSUES + 1))
fi

# Check ContributorPayout maps amountMinor
if ! grep -q "amountMinor" "$MODEL"; then
  echo "FAIL: model does not map amountMinor"
  ISSUES=$((ISSUES + 1))
fi

# Check ContributorDashboardData reads royaltySummary
if ! grep -q "royaltySummary" "$MODEL"; then
  echo "FAIL: model does not read royaltySummary"
  ISSUES=$((ISSUES + 1))
fi

if [ "$ISSUES" -eq 0 ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: All field mappings (productTitle, salesCount, milestoneType, amountMinor, royaltySummary, dashboard unwrap) present"
  echo "COMMAND: grep checks on $PROVIDER and $MODEL"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $ISSUES field mapping(s) missing — see FAIL lines above"
  echo "COMMAND: grep checks on $PROVIDER and $MODEL"
  exit 1
fi
