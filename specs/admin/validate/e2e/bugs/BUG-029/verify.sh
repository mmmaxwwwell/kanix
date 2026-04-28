#!/usr/bin/env bash
# Verifies BUG-029 — GET /api/customer/me returns emailVerified field.
set -eu
source test/e2e/.state/env 2>/dev/null || true

curl -s -o /tmp/bug029.out \
  "${API_URL}/api/customer/me" \
  -H "cookie: ${CUSTOMER_COOKIE:-}"

HTTP_STATUS=$(curl -s -o /dev/null -w '%{http_code}' \
  "${API_URL}/api/customer/me" \
  -H "cookie: ${CUSTOMER_COOKIE:-}")

if [ "$HTTP_STATUS" != "200" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: GET /api/customer/me returned HTTP $HTTP_STATUS"
  echo "COMMAND: curl \$API_URL/api/customer/me -H 'cookie: \$CUSTOMER_COOKIE'"
  exit 2
fi

HAS_EMAIL_VERIFIED=$(jq '.customer | has("emailVerified")' /tmp/bug029.out 2>/dev/null || echo "false")

if [ "$HAS_EMAIL_VERIFIED" = "true" ]; then
  VALUE=$(jq '.customer.emailVerified' /tmp/bug029.out)
  echo "STATUS: FIXED"
  echo "EVIDENCE: GET /api/customer/me returns emailVerified=$VALUE"
  echo "COMMAND: curl \$API_URL/api/customer/me -H 'cookie: \$CUSTOMER_COOKIE'"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: emailVerified missing from response: $(cat /tmp/bug029.out)"
  echo "COMMAND: curl \$API_URL/api/customer/me -H 'cookie: \$CUSTOMER_COOKIE'"
  exit 1
fi
