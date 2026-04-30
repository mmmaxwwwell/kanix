#!/usr/bin/env bash
# Verifies INFRA-orders-screen-anr — GET /api/admin/orders returns ≤100 orders
# even when the DB contains thousands, confirming server-side pagination is active.
set -eu

API_URL="${API_URL:-http://127.0.0.1:3000}"

# Need an admin session cookie — use ADMIN_COOKIE if set, else inconclusive
if [ -z "${ADMIN_COOKIE:-}" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: ADMIN_COOKIE not set — cannot call authenticated endpoint"
  exit 2
fi

RESPONSE=$(curl -s -o /tmp/infra-orders-resp.json -w '%{http_code}' \
  -H "Cookie: $ADMIN_COOKIE" \
  "$API_URL/api/admin/orders")

if [ "$RESPONSE" != "200" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: GET /api/admin/orders returned $RESPONSE"
  exit 1
fi

ORDER_COUNT=$(python3 -c "import json,sys; d=json.load(open('/tmp/infra-orders-resp.json')); print(len(d['orders']))")
TOTAL=$(python3 -c "import json,sys; d=json.load(open('/tmp/infra-orders-resp.json')); print(d.get('total','missing'))")

if [ "$ORDER_COUNT" -le 100 ] && [ "$TOTAL" != "missing" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: GET /api/admin/orders returned $ORDER_COUNT orders (total=$TOTAL) — pagination active, limit respected"
  echo "COMMAND: curl -H 'Cookie: ADMIN_COOKIE' $API_URL/api/admin/orders"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: response has $ORDER_COUNT orders and total=$TOTAL — pagination not applied"
  echo "COMMAND: curl -H 'Cookie: ADMIN_COOKIE' $API_URL/api/admin/orders"
  exit 1
fi
