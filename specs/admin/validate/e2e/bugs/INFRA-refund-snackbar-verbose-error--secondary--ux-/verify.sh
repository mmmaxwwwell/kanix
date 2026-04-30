#!/usr/bin/env bash
# Verifies INFRA-refund-snackbar-verbose-error — same fix as BUG-refund-error-verbose-message.
# Checks the APK kernel for the concise error fallback string.
set -eu

APK=$(find admin/build/app/outputs -name '*-debug.apk' 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: No debug APK found — build may not have run yet"
  echo "COMMAND: find admin/build/app/outputs -name '*-debug.apk'"
  exit 2
fi

if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q 'payment provider error'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK kernel_blob.bin contains 'payment provider error' — concise error message deployed"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep 'payment provider error'"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK does not contain 'payment provider error' — fix not in APK"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep 'payment provider error'"
  exit 1
fi
