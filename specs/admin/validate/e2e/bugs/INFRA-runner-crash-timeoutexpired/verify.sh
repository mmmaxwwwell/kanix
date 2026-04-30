#!/usr/bin/env bash
# Verifies INFRA-runner-crash-timeoutexpired — parallel_runner.py catches TimeoutExpired for adb logcat.
set -eu

RUNNER="/home/max/git/agent-framework/.claude/skills/spec-kit/parallel_runner.py"

if [ ! -f "$RUNNER" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: parallel_runner.py not found at $RUNNER"
  echo "COMMAND: ls $RUNNER"
  exit 2
fi

# Check that timeout=30 (not 15) is used and TimeoutExpired is caught near the adb logcat call
if grep -q "timeout=30" "$RUNNER" && grep -q "TimeoutExpired" "$RUNNER"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: parallel_runner.py has timeout=30 and catches TimeoutExpired for adb logcat"
  echo "COMMAND: grep -n 'timeout=30\|TimeoutExpired' $RUNNER | head -5"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: parallel_runner.py missing timeout=30 or TimeoutExpired handler"
  echo "COMMAND: grep -n 'adb.*logcat\|TimeoutExpired' $RUNNER"
  exit 1
fi
