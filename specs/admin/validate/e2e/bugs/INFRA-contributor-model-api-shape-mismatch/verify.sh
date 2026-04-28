#!/usr/bin/env bash
# Verifies INFRA-contributor-model-api-shape-mismatch — same check as BUG-033
set -eu

PROVIDER="customer/lib/providers/contributor_provider.dart"
MODEL="customer/lib/models/contributor.dart"

ISSUES=0

if ! grep -q "\['dashboard'\]" "$PROVIDER"; then
  echo "FAIL: provider does not unwrap response['dashboard']"
  ISSUES=$((ISSUES + 1))
fi

if ! grep -q "productTitle" "$MODEL"; then
  echo "FAIL: model does not map productTitle"
  ISSUES=$((ISSUES + 1))
fi

if ! grep -q "salesCount" "$MODEL"; then
  echo "FAIL: model does not map salesCount"
  ISSUES=$((ISSUES + 1))
fi

if ! grep -q "milestoneType" "$MODEL"; then
  echo "FAIL: model does not map milestoneType"
  ISSUES=$((ISSUES + 1))
fi

if ! grep -q "amountMinor" "$MODEL"; then
  echo "FAIL: model does not map amountMinor"
  ISSUES=$((ISSUES + 1))
fi

if ! grep -q "royaltySummary" "$MODEL"; then
  echo "FAIL: model does not read royaltySummary"
  ISSUES=$((ISSUES + 1))
fi

if [ "$ISSUES" -eq 0 ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: All field mappings present in model and provider"
  echo "COMMAND: grep checks on $PROVIDER and $MODEL"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $ISSUES field mapping(s) missing"
  echo "COMMAND: grep checks on $PROVIDER and $MODEL"
  exit 1
fi
