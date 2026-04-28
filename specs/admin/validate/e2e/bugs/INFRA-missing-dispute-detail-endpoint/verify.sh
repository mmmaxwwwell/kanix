#!/usr/bin/env bash
# Verifies INFRA-missing-dispute-detail-endpoint — same check as BUG-024.
set -eu
DISPUTE_ID=$(curl -s "${API_URL}/api/admin/disputes" \
  -H "cookie: ${ADMIN_COOKIE}" \
  | jq -r '.disputes[0].id // empty')
if [ -z "$DISPUTE_ID" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: No disputes in list"
  exit 2
fi
CODE=$(curl -s -o /tmp/infra-detail.out -w '%{http_code}' \
  "${API_URL}/api/admin/disputes/${DISPUTE_ID}" \
  -H "cookie: ${ADMIN_COOKIE}")
if [ "$CODE" = "200" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: GET /api/admin/disputes/${DISPUTE_ID} returned 200"
  echo "COMMAND: curl ${API_URL}/api/admin/disputes/${DISPUTE_ID}"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: GET /api/admin/disputes/${DISPUTE_ID} returned ${CODE}"
  echo "COMMAND: curl ${API_URL}/api/admin/disputes/${DISPUTE_ID}"
  exit 1
fi
