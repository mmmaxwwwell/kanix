#!/usr/bin/env bash
# Verifies BUG-025 — search param filters disputes by providerDisputeId.
set -eu

# Get a real providerDisputeId to search for
PROVIDER_ID=$(curl -s "${API_URL}/api/admin/disputes" \
  -H "cookie: ${ADMIN_COOKIE}" \
  | jq -r '.disputes[0].providerDisputeId // empty')

if [ -z "$PROVIDER_ID" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: No disputes available to test search"
  exit 2
fi

# Search by full providerDisputeId — should return exactly 1 result
TOTAL=$(curl -s "${API_URL}/api/admin/disputes?search=${PROVIDER_ID}" \
  -H "cookie: ${ADMIN_COOKIE}" \
  | jq '.total')

# Also verify that a nonsense search returns 0 results
ZERO=$(curl -s "${API_URL}/api/admin/disputes?search=XXXX_no_match_XXXX_99999" \
  -H "cookie: ${ADMIN_COOKIE}" \
  | jq '.total')

if [ "$TOTAL" = "1" ] && [ "$ZERO" = "0" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: search=${PROVIDER_ID} returned total=1; search=XXXX_no_match_XXXX_99999 returned total=0"
  echo "COMMAND: curl ${API_URL}/api/admin/disputes?search=${PROVIDER_ID}"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: search by providerDisputeId returned total=${TOTAL} (want 1); nonsense search returned total=${ZERO} (want 0)"
  echo "COMMAND: curl ${API_URL}/api/admin/disputes?search=${PROVIDER_ID}"
  exit 1
fi
