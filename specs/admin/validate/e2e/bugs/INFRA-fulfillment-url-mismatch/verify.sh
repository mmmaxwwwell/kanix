#!/usr/bin/env bash
# Verifies INFRA-fulfillment-url-mismatch — fulfillment_provider.dart uses correct URL.
set -eu
FILE="admin/lib/providers/fulfillment_provider.dart"
if grep -q "fulfillment-tasks'" "$FILE" \
   && ! grep -qE "dio\.get\('/api/admin/fulfillment'[^-]" "$FILE"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: fulfillment_provider.dart uses /api/admin/fulfillment-tasks"
  echo "COMMAND: grep dio.get admin/lib/providers/fulfillment_provider.dart"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: fulfillment_provider.dart still references wrong URL"
  echo "COMMAND: grep dio.get admin/lib/providers/fulfillment_provider.dart"
  grep "dio.get" "$FILE" || true
  exit 1
fi
