#!/usr/bin/env bash
# Verifies INFRA-mcp-android-not-connected
# The config-level fix (ANDROID_BUILD_ROOT=admin) is verifiable by grep.
# The connectivity fix (runner liveness check) requires a live session — exit 2.
set -eu

# Check the config fix is present
if grep -q '"ANDROID_BUILD_ROOT": "admin"' .mcp.json; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: .mcp.json has ANDROID_BUILD_ROOT=admin (was 'customer')"
  echo "COMMAND: grep ANDROID_BUILD_ROOT .mcp.json"
  echo "NOTE: Runner-side liveness check (parallel_runner.py) still needs host-side patch — see fix-approach-latest.md"
  exit 2
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: .mcp.json does not have ANDROID_BUILD_ROOT=admin"
  echo "COMMAND: grep ANDROID_BUILD_ROOT .mcp.json"
  exit 1
fi
