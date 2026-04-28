#!/usr/bin/env bash
# Verifies BUG-021 — Dispute.fromJson no longer crashes on API field names.
# Checks that the APK kernel_blob.bin references 'providerDisputeId' (post-fix field).
set -eu

APK=$(find admin/build/app/outputs -name '*-debug.apk' 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: No debug APK found — app not built"
  echo "COMMAND: find admin/build/app/outputs -name '*-debug.apk'"
  exit 1
fi

if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q 'providerDisputeId'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK kernel_blob.bin contains 'providerDisputeId' — post-fix field mapping applied"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep providerDisputeId"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK does not contain 'providerDisputeId' — Gradle cache hit or fix not compiled"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep providerDisputeId"
  exit 1
fi
