#!/usr/bin/env bash
# Verifies INFRA-dispute-search-not-implemented — same check as BUG-025.
set -eu
PROVIDER_ID=$(curl -s "${API_URL}/api/admin/disputes" \
  -H "cookie: ${ADMIN_COOKIE}" \
  | jq -r '.disputes[0].providerDisputeId // empty')
if [ -z "$PROVIDER_ID" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: No disputes available"
  exit 2
fi
TOTAL=$(curl -s "${API_URL}/api/admin/disputes?search=${PROVIDER_ID}" \
  -H "cookie: ${ADMIN_COOKIE}" \
  | jq '.total')
ZERO=$(curl -s "${API_URL}/api/admin/disputes?search=XXXX_no_match_XXXX_99999" \
  -H "cookie: ${ADMIN_COOKIE}" \
  | jq '.total')
if [ "$TOTAL" = "1" ] && [ "$ZERO" = "0" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: search filtering works: exact match=1, no-match=0"
  echo "COMMAND: curl ${API_URL}/api/admin/disputes?search=${PROVIDER_ID}"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: exact match returned ${TOTAL} (want 1), no-match returned ${ZERO} (want 0)"
  echo "COMMAND: curl ${API_URL}/api/admin/disputes?search=${PROVIDER_ID}"
  exit 1
fi
