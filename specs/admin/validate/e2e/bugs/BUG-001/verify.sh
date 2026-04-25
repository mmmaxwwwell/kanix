#!/usr/bin/env bash
# Verifies BUG-001 — fulfillment_provider.dart uses the correct URL.
set -eu
FILE="admin/lib/providers/fulfillment_provider.dart"
if grep -q "dio.get('/api/admin/fulfillment-tasks')" "$FILE" \
   && grep -q "dio.get('/api/admin/fulfillment-tasks/\$taskId')" "$FILE" \
   && ! grep -q "dio.get('/api/admin/fulfillment'[^-]" "$FILE"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: fulfillment_provider.dart uses /api/admin/fulfillment-tasks (not /api/admin/fulfillment)"
  echo "COMMAND: grep dio.get admin/lib/providers/fulfillment_provider.dart"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: fulfillment_provider.dart still has wrong URL"
  echo "COMMAND: grep dio.get admin/lib/providers/fulfillment_provider.dart"
  grep "dio.get" "$FILE" || true
  exit 1
fi
