#!/usr/bin/env bash
# Verifies BUG-002 — setup.sh contains admin APK install step.
set -eu
FILE="test/e2e/setup.sh"
if grep -q "flutter build apk --debug" "$FILE" \
   && grep -q "kanix_admin" "$FILE" \
   && grep -q "adb.*install" "$FILE"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: setup.sh contains admin APK build+install step (Step 6c)"
  echo "COMMAND: grep -c 'kanix_admin' test/e2e/setup.sh"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: setup.sh missing admin APK install step"
  echo "COMMAND: grep 'kanix_admin\\|flutter build apk' test/e2e/setup.sh"
  exit 1
fi
