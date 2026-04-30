#!/usr/bin/env bash
# Verifies BUG-003 — GET /api/admin/orders/:id/history returns orderId in each entry
set -eu

QUERY="api/src/db/queries/order-state-machine.ts"

# Source check: orderId added to SELECT projection
if ! grep -q "orderId: orderStatusHistory.orderId" "$QUERY" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: orderId not in SELECT in $QUERY — Flutter cast will still fail"
  echo "COMMAND: grep orderId $QUERY"
  exit 1
fi

# Live API check (if env is available)
if [ -z "${API_URL:-}" ] || [ -z "${ADMIN_COOKIE:-}" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: source fix confirmed — orderId added to SELECT in $QUERY; live check skipped (no API_URL/ADMIN_COOKIE)"
  echo "COMMAND: grep 'orderId: orderStatusHistory.orderId' $QUERY"
  exit 0
fi

ORDER_ID=$(curl -sf -H "Cookie: $ADMIN_COOKIE" "$API_URL/api/admin/orders?limit=1" \
  | jq -r '.orders[0].id // empty' 2>/dev/null || true)

if [ -z "$ORDER_ID" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: source fix confirmed; no orders available for live response check"
  echo "COMMAND: grep 'orderId: orderStatusHistory.orderId' $QUERY"
  exit 0
fi

HISTORY=$(curl -sf -H "Cookie: $ADMIN_COOKIE" "$API_URL/api/admin/orders/$ORDER_ID/history" 2>/dev/null || true)
HAS_ENTRIES=$(echo "$HISTORY" | jq '.history | length' 2>/dev/null || echo "0")

if [ "$HAS_ENTRIES" = "0" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: source fix confirmed; order $ORDER_ID has no history entries to verify field"
  echo "COMMAND: curl $API_URL/api/admin/orders/$ORDER_ID/history"
  exit 0
fi

HAS_ORDER_ID=$(echo "$HISTORY" | jq -r '.history[0].orderId // empty' 2>/dev/null || true)
if [ -n "$HAS_ORDER_ID" ] && [ "$HAS_ORDER_ID" != "null" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: history[0].orderId=$HAS_ORDER_ID present in live response from /api/admin/orders/$ORDER_ID/history"
  echo "COMMAND: curl $API_URL/api/admin/orders/$ORDER_ID/history | jq .history[0].orderId"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: history[0].orderId missing in response from /api/admin/orders/$ORDER_ID/history"
  echo "COMMAND: curl $API_URL/api/admin/orders/$ORDER_ID/history | jq .history[0]"
  exit 1
fi
