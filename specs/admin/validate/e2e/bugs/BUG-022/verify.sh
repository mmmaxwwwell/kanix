#!/usr/bin/env bash
# Verifies BUG-022 — POST /api/admin/disputes/:id/generate-bundle no longer returns 500.
set -eu

DISPUTE_ID="68fcd36b-fe99-432d-a79e-8820c6e2cd96"

CODE=$(curl -s -o /tmp/bug022.out -w '%{http_code}' \
  -X POST "${API_URL}/api/admin/disputes/${DISPUTE_ID}/generate-bundle" \
  -H "Cookie: ${ADMIN_COOKIE}" \
  -H "Content-Type: application/json" \
  -d '{}')

if [ "$CODE" = "200" ]; then
  BUNDLE_ID=$(jq -r '.bundle_id // empty' /tmp/bug022.out 2>/dev/null || echo "")
  echo "STATUS: FIXED"
  echo "EVIDENCE: POST /api/admin/disputes/$DISPUTE_ID/generate-bundle returned 200 (bundle_id=$BUNDLE_ID)"
  echo "COMMAND: curl -X POST API_URL/api/admin/disputes/$DISPUTE_ID/generate-bundle"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: POST /api/admin/disputes/$DISPUTE_ID/generate-bundle returned $CODE"
  echo "COMMAND: curl -X POST API_URL/api/admin/disputes/$DISPUTE_ID/generate-bundle"
  cat /tmp/bug022.out
  exit 1
fi
