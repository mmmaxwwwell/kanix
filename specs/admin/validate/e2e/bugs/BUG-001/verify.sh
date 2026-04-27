#!/usr/bin/env bash
# Verifies BUG-001 — fulfillment_screen.dart uses /fulfillment-tasks/ not /fulfillment/
set -eu

SCREEN="admin/lib/screens/fulfillment_screen.dart"

# Check source: must not contain old wrong path
if grep -q "'/api/admin/fulfillment/\${task.id}/" "$SCREEN" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $SCREEN still contains /api/admin/fulfillment/\${task.id}/ (missing -tasks)"
  echo "COMMAND: grep -n fulfillment $SCREEN"
  exit 1
fi

# Check source: must contain correct path for both transition and assign
if grep -q "'/api/admin/fulfillment-tasks/\${task.id}/" "$SCREEN" 2>/dev/null; then
  COUNT=$(grep -c "fulfillment-tasks" "$SCREEN" || true)
  echo "STATUS: FIXED"
  echo "EVIDENCE: $SCREEN has $COUNT occurrences of /api/admin/fulfillment-tasks/ (no old path)"
  echo "COMMAND: grep -c fulfillment-tasks $SCREEN"
  exit 0
fi

echo "STATUS: STILL_BROKEN"
echo "EVIDENCE: $SCREEN does not contain expected /api/admin/fulfillment-tasks/ path"
echo "COMMAND: grep fulfillment $SCREEN"
exit 1
