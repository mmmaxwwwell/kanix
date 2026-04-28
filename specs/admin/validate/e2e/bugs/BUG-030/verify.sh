#!/usr/bin/env bash
# Verifies BUG-030 — /api/contributors/dashboard (plural) path in Flutter APK.
set -eu

APK=$(find customer/build/app/outputs -name '*-debug.apk' 2>/dev/null | head -1)

if [ -z "$APK" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: No customer debug APK found — cannot verify"
  echo "COMMAND: find customer/build/app/outputs -name '*-debug.apk'"
  exit 2
fi

if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q '/api/contributors/dashboard'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK kernel_blob.bin contains '/api/contributors/dashboard' (plural)"
  echo "COMMAND: unzip -p \$APK assets/flutter_assets/kernel_blob.bin | strings | grep contributors/dashboard"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK does not contain '/api/contributors/dashboard' — Gradle cache hit or source not rebuilt"
  echo "COMMAND: unzip -p \$APK assets/flutter_assets/kernel_blob.bin | strings | grep contributor/dashboard"
  exit 1
fi
