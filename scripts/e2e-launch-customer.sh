#!/usr/bin/env bash
# e2e-launch-customer.sh — Cold-start the Kanix customer app on the running emulator
#
# App package ID: com.kanix.kanix_customer
# Main activity:  com.kanix.kanix_customer.MainActivity
#
# Idempotent: force-stops any existing instance before launching.
set -euo pipefail

PACKAGE="com.kanix.kanix_customer"
ACTIVITY="$PACKAGE/.MainActivity"

# Verify adb is available
if ! command -v adb >/dev/null 2>&1; then
  echo "FAIL: adb not found in PATH."
  exit 1
fi

# Verify device is connected
DEVICE_COUNT=$(adb devices | grep -c -E '\t(device|emulator)' || true)
if [ "$DEVICE_COUNT" -eq 0 ]; then
  echo "FAIL: No connected Android device or emulator found."
  exit 1
fi

echo "Cold-starting customer app ($PACKAGE)..."

# Force-stop to ensure a cold start
adb shell am force-stop "$PACKAGE" 2>/dev/null || true

# Launch the main activity
adb shell am start -n "$ACTIVITY" -a android.intent.action.MAIN -c android.intent.category.LAUNCHER

echo "Customer app launched."
