#!/usr/bin/env bash
# Verifies BUG-028 — GET /api/admin/contributors/:id/designs includes salesCount.
set -eu
source test/e2e/.state/env 2>/dev/null || true

# Find first contributor
CONTRIB_ID=$(curl -s "${API_URL}/api/admin/contributors" \
  -H "cookie: ${ADMIN_COOKIE:-}" | jq -r '.contributors[0].id // empty')

if [ -z "$CONTRIB_ID" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: No contributors found — cannot verify salesCount field"
  echo "COMMAND: curl \$API_URL/api/admin/contributors -H 'cookie: \$ADMIN_COOKIE'"
  exit 2
fi

curl -s -o /tmp/bug028.out \
  "${API_URL}/api/admin/contributors/${CONTRIB_ID}/designs" \
  -H "cookie: ${ADMIN_COOKIE:-}"

# Check if any design has salesCount field
HAS_SALES_COUNT=$(jq '[.designs[] | has("salesCount")] | all' /tmp/bug028.out 2>/dev/null || echo "false")
DESIGN_COUNT=$(jq '.designs | length' /tmp/bug028.out 2>/dev/null || echo "0")

if [ "$DESIGN_COUNT" = "0" ]; then
  # No designs to check — inconclusive
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: Contributor $CONTRIB_ID has no designs — cannot verify salesCount"
  echo "COMMAND: curl \$API_URL/api/admin/contributors/$CONTRIB_ID/designs -H 'cookie: \$ADMIN_COOKIE'"
  exit 2
fi

if [ "$HAS_SALES_COUNT" = "true" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: designs[*].salesCount present in response for contributor $CONTRIB_ID"
  echo "COMMAND: curl \$API_URL/api/admin/contributors/$CONTRIB_ID/designs -H 'cookie: \$ADMIN_COOKIE'"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: salesCount missing from designs: $(cat /tmp/bug028.out | jq '.designs[0]')"
  echo "COMMAND: curl \$API_URL/api/admin/contributors/$CONTRIB_ID/designs -H 'cookie: \$ADMIN_COOKIE'"
  exit 1
fi
