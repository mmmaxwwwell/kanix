#!/usr/bin/env bash
# Verifies BUG-027 — GET /api/admin/orders returns real data (not hardcoded []).
set -eu
source test/e2e/.state/env 2>/dev/null || true

RESPONSE=$(curl -s -o /tmp/bug027.out -w '%{http_code}' \
  "${API_URL}/api/admin/orders" \
  -H "cookie: ${ADMIN_COOKIE:-}")

if [ "$RESPONSE" != "200" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: GET /api/admin/orders returned HTTP $RESPONSE"
  echo "COMMAND: curl \$API_URL/api/admin/orders -H 'cookie: \$ADMIN_COOKIE'"
  cat /tmp/bug027.out
  exit 1
fi

# Verify response has "orders" key and is not always empty (check it's an array)
ORDERS_KEY=$(jq 'has("orders")' /tmp/bug027.out 2>/dev/null || echo "false")
if [ "$ORDERS_KEY" != "true" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: Response missing 'orders' key: $(cat /tmp/bug027.out)"
  echo "COMMAND: curl \$API_URL/api/admin/orders -H 'cookie: \$ADMIN_COOKIE'"
  exit 1
fi

# Verify it returns an array (not hardcoded stub)
IS_ARRAY=$(jq '.orders | type == "array"' /tmp/bug027.out 2>/dev/null || echo "false")
if [ "$IS_ARRAY" != "true" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: orders is not an array: $(cat /tmp/bug027.out)"
  echo "COMMAND: curl \$API_URL/api/admin/orders -H 'cookie: \$ADMIN_COOKIE'"
  exit 1
fi

COUNT=$(jq '.orders | length' /tmp/bug027.out)
echo "STATUS: FIXED"
echo "EVIDENCE: GET /api/admin/orders returned 200 with orders array (count=$COUNT)"
echo "COMMAND: curl \$API_URL/api/admin/orders -H 'cookie: \$ADMIN_COOKIE'"
exit 0
