#!/usr/bin/env bash
# Verifies BUG-002 — shipments_screen.dart uses /buy-label not /purchase-label
set -eu

SCREEN="admin/lib/screens/shipments_screen.dart"

if grep -q "purchase-label" "$SCREEN" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $SCREEN still contains /purchase-label (should be /buy-label)"
  echo "COMMAND: grep purchase-label $SCREEN"
  exit 1
fi

if grep -q "buy-label" "$SCREEN" 2>/dev/null; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: $SCREEN contains /buy-label (correct API endpoint)"
  echo "COMMAND: grep buy-label $SCREEN"
  exit 0
fi

echo "STATUS: STILL_BROKEN"
echo "EVIDENCE: $SCREEN does not contain /buy-label"
echo "COMMAND: grep -n label $SCREEN"
exit 1
