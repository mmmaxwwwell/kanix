#!/usr/bin/env bash
# Verifies INFRA-admin-apk-rebuild-failed — admin APK was rebuilt from fixed source.
# Checks: (1) APK exists and mtime postdates fix commit dadef4a,
#          (2) kernel_blob.bin contains /api/admin/fulfillment-tasks (not old URL).
set -eu
APK="admin/build/app/outputs/flutter-apk/app-debug.apk"
FIX_COMMIT_EPOCH=1777150660  # dadef4a: fix(e2e): fix fulfillment 404, 2026-04-25 20:57:40 UTC

if [ ! -f "$APK" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK not found at $APK — flutter build apk --debug not run"
  echo "COMMAND: ls $APK"
  exit 1
fi

APK_MTIME=$(stat -c '%Y' "$APK")
if [ "$APK_MTIME" -le "$FIX_COMMIT_EPOCH" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK mtime $APK_MTIME <= fix commit epoch $FIX_COMMIT_EPOCH — Gradle cache hit, flutter clean required"
  echo "COMMAND: stat -c '%Y' $APK"
  exit 1
fi

BLOB_URLS=$(unzip -p "$APK" assets/flutter_assets/kernel_blob.bin | strings | grep "fulfillment" | grep "dio.get" || true)
if echo "$BLOB_URLS" | grep -q "/api/admin/fulfillment-tasks"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK mtime=$APK_MTIME > fix commit epoch=$FIX_COMMIT_EPOCH; kernel_blob.bin contains /api/admin/fulfillment-tasks"
  echo "COMMAND: stat -c '%Y' $APK && unzip -p $APK assets/flutter_assets/kernel_blob.bin | strings | grep fulfillment"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK mtime=$APK_MTIME > fix epoch but kernel_blob.bin missing expected URL"
  echo "COMMAND: unzip -p $APK assets/flutter_assets/kernel_blob.bin | strings | grep fulfillment"
  echo "$BLOB_URLS" || true
  exit 1
fi
