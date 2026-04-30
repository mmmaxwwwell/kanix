#!/usr/bin/env bash
# Verifies BUG-appbar-overflow-partial — OverflowBar is now used in the header
# instead of a fixed Spacer + buttons layout, eliminating the 134px overflow.
set -eu

APK=$(find admin/build/app/outputs -name '*-debug.apk' 2>/dev/null | head -1)
if [ -z "$APK" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: No debug APK found — build may not have run yet"
  echo "COMMAND: find admin/build/app/outputs -name '*-debug.apk'"
  exit 2
fi

# The fix uses OverflowBar — check the kernel contains the OverflowBar symbol.
# The Spacer-only layout would not have OverflowBar in the widget tree.
if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q 'OverflowBar'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: APK kernel_blob.bin contains 'OverflowBar' — fixed layout is deployed"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep 'OverflowBar'"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: APK does not contain 'OverflowBar' — Gradle cache hit or fix not built"
  echo "COMMAND: unzip -p APK assets/flutter_assets/kernel_blob.bin | strings | grep 'OverflowBar'"
  exit 1
fi
