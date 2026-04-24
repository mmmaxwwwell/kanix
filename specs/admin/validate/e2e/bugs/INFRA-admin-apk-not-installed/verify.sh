#!/usr/bin/env bash
# Verifies INFRA-admin-apk-not-installed — com.kanix.kanix_admin is installed on emulator-5554.
set -eu

if ! command -v adb >/dev/null 2>&1; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: adb not found in PATH"
  echo "COMMAND: command -v adb"
  exit 1
fi

if ! adb -s emulator-5554 get-state >/dev/null 2>&1; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: emulator-5554 not reachable via adb"
  echo "COMMAND: adb -s emulator-5554 get-state"
  exit 1
fi

if adb -s emulator-5554 shell pm list packages 2>/dev/null | grep -q 'com.kanix.kanix_admin'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: com.kanix.kanix_admin found in pm list packages"
  echo "COMMAND: adb -s emulator-5554 shell pm list packages | grep kanix_admin"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: com.kanix.kanix_admin not found in pm list packages"
  echo "COMMAND: adb -s emulator-5554 shell pm list packages | grep kanix_admin"
  exit 1
fi
