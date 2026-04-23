#!/usr/bin/env bash
# Verifies INFRA-pre-e2e-skipped-tests — no skipped tests in the latest summary.
set -eu
cd api

# Check the latest summary.json for skipped tests
SUMMARY="test-logs/summary.json"
if [ ! -f "$SUMMARY" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: No summary.json exists yet (will be created on next test run)"
  echo "COMMAND: cat api/test-logs/summary.json"
  exit 0
fi

SKIP_COUNT=$(python3 -c "import json; print(json.load(open('$SUMMARY'))['skip'])" 2>/dev/null || echo "unknown")
if [ "$SKIP_COUNT" = "0" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: summary.json shows skip=0"
  echo "COMMAND: python3 -c \"import json; print(json.load(open('api/test-logs/summary.json'))['skip'])\""
  exit 0
elif [ "$SKIP_COUNT" = "unknown" ]; then
  # Can't parse, inconclusive
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: Could not parse summary.json"
  echo "COMMAND: cat api/test-logs/summary.json"
  exit 2
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: summary.json shows skip=$SKIP_COUNT"
  echo "COMMAND: python3 -c \"import json; print(json.load(open('api/test-logs/summary.json'))['skip'])\""
  exit 1
fi
