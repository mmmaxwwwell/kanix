#!/usr/bin/env bash
# Verifies INFRA-emulator-oom-killed — emulator is running and fully booted
set -eu

if ! command -v adb >/dev/null 2>&1; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: adb not found in PATH"
  echo "COMMAND: adb devices"
  exit 1
fi

if ! adb devices 2>/dev/null | grep -q "emulator-5554.*device"; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: emulator-5554 not in 'device' state ($(adb devices 2>/dev/null | tail -n +2 | head -5))"
  echo "COMMAND: adb devices"
  exit 1
fi

BOOT=$(adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')
if [ "$BOOT" = "1" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: emulator-5554 is in 'device' state and sys.boot_completed=1"
  echo "COMMAND: adb devices && adb -s emulator-5554 shell getprop sys.boot_completed"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: emulator-5554 found but sys.boot_completed=$BOOT (not yet booted)"
  echo "COMMAND: adb -s emulator-5554 shell getprop sys.boot_completed"
  exit 1
fi
