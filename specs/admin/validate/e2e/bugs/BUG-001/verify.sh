#!/usr/bin/env bash
# Verifies BUG-001 — installed admin APK calls /api/admin/fulfillment-tasks (not /api/admin/fulfillment)
# Checks APK binary (kernel_blob.bin) for correct URL strings.
set -eu
APK="admin/build/app/outputs/flutter-apk/app-debug.apk"
if [ ! -f "$APK" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK not found at $APK — needs rebuild"
  echo "COMMAND: ls $APK"
  exit 1
fi
BLOB_URLS=$(unzip -p "$APK" assets/flutter_assets/kernel_blob.bin | strings | grep "fulfillment" | grep "dio.get" || true)
if echo "$BLOB_URLS" | grep -q "/api/admin/fulfillment-tasks" \
   && ! echo "$BLOB_URLS" | grep -qE "dio\.get\('/api/admin/fulfillment'[^-]"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK kernel_blob.bin contains /api/admin/fulfillment-tasks (correct URL, not old /api/admin/fulfillment)"
  echo "COMMAND: unzip -p $APK assets/flutter_assets/kernel_blob.bin | strings | grep fulfillment"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK kernel_blob.bin still has wrong URL — flutter clean && flutter build apk --debug required"
  echo "COMMAND: unzip -p $APK assets/flutter_assets/kernel_blob.bin | strings | grep fulfillment"
  echo "$BLOB_URLS" || true
  exit 1
fi
