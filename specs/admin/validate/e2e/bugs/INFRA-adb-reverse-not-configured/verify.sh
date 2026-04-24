#!/usr/bin/env bash
# Verifies INFRA-adb-reverse-not-configured — adb reverse rules are configured on emulator-5554.
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

REVERSE_LIST=$(adb -s emulator-5554 reverse --list 2>/dev/null || true)

if echo "$REVERSE_LIST" | grep -q 'tcp:3000' && echo "$REVERSE_LIST" | grep -q 'tcp:3567'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: adb reverse rules present: $(echo "$REVERSE_LIST" | tr '\n' ' ')"
  echo "COMMAND: adb -s emulator-5554 reverse --list"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: adb reverse --list output: $(echo "$REVERSE_LIST" | tr '\n' ' ' || echo '(empty)')"
  echo "COMMAND: adb -s emulator-5554 reverse --list"
  exit 1
fi
