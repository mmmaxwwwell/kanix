#!/usr/bin/env bash
# Verifies INFRA-pre-e2e-api--pnpm-run-test — pnpm test exits 0 with no failures.
set -eu
cd api
OUTPUT=$(pnpm test 2>&1) || {
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: pnpm test exited non-zero"
  echo "COMMAND: pnpm --dir api test"
  echo "$OUTPUT" | tail -20
  exit 1
}
if echo "$OUTPUT" | grep -q "Test Files.*passed"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: $(echo "$OUTPUT" | grep 'Test Files')"
  echo "COMMAND: pnpm --dir api test"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: unexpected output format"
  echo "COMMAND: pnpm --dir api test"
  exit 1
fi
