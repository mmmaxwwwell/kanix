#!/usr/bin/env bash
# Verifies BUG-024 — GET /api/admin/disputes/:id returns 200 with dispute fields.
set -eu

# Get the first dispute ID from the list
DISPUTE_ID=$(curl -s "${API_URL}/api/admin/disputes" \
  -H "cookie: ${ADMIN_COOKIE}" \
  | jq -r '.disputes[0].id // empty')

if [ -z "$DISPUTE_ID" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: No disputes found in list to test detail endpoint"
  exit 2
fi

CODE=$(curl -s -o /tmp/bug024.out -w '%{http_code}' \
  "${API_URL}/api/admin/disputes/${DISPUTE_ID}" \
  -H "cookie: ${ADMIN_COOKIE}")

if [ "$CODE" = "200" ]; then
  PROVIDER_ID=$(jq -r '.dispute.providerDisputeId // empty' /tmp/bug024.out)
  echo "STATUS: FIXED"
  echo "EVIDENCE: GET /api/admin/disputes/${DISPUTE_ID} returned 200 (providerDisputeId=${PROVIDER_ID})"
  echo "COMMAND: curl ${API_URL}/api/admin/disputes/${DISPUTE_ID}"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: GET /api/admin/disputes/${DISPUTE_ID} returned ${CODE}"
  echo "COMMAND: curl ${API_URL}/api/admin/disputes/${DISPUTE_ID}"
  cat /tmp/bug024.out
  exit 1
fi
