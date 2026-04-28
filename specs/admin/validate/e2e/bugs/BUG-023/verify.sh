#!/usr/bin/env bash
# Verifies BUG-023 — Submit Bundle button exists in built APK.
set -eu

APK=$(find admin/build/app/outputs -name '*-debug.apk' 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: No debug APK found — app not built"
  echo "COMMAND: find admin/build/app/outputs -name '*-debug.apk'"
  exit 1
fi

if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q 'submit-bundle'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK kernel_blob.bin contains 'submit-bundle' — Submit Bundle button compiled in"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep submit-bundle"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK does not contain 'submit-bundle' — fix not compiled into APK"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep submit-bundle"
  exit 1
fi
