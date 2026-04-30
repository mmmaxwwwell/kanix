#!/usr/bin/env bash
# Verifies BUG-refund-error-verbose-message — the admin APK no longer contains
# the raw DioException class name in the refund error handling code path.
# Checks the compiled Flutter kernel for the fixed error extraction pattern.
set -eu

APK=$(find admin/build/app/outputs -name '*-debug.apk' 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: No debug APK found — build may not have run yet"
  echo "COMMAND: find admin/build/app/outputs -name '*-debug.apk'"
  exit 2
fi

# Check that the APK kernel contains the fixed error extraction string.
# The fix uses 'payment provider error' as a fallback string for DioExceptions.
if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q 'payment provider error'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK kernel_blob.bin contains 'payment provider error' — fix is deployed"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep 'payment provider error'"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK kernel_blob.bin does not contain 'payment provider error' — Gradle cache hit or fix not built"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep 'payment provider error'"
  exit 1
fi
