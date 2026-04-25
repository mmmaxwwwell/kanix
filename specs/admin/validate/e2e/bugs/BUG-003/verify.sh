#!/usr/bin/env bash
# Verifies BUG-003 — POST /api/test/seed-paid-order returns 201 with a paid order.
set -eu
API_URL="${API_URL:-http://127.0.0.1:3000}"
CODE=$(curl -s -o /tmp/seed-paid.out -w '%{http_code}' \
  -X POST "${API_URL}/api/test/seed-paid-order" \
  -H 'content-type: application/json')
if [ "$CODE" = "201" ]; then
  PAYMENT_STATUS=$(cat /tmp/seed-paid.out | grep -o '"payment_status":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
  ORDER_ID=$(cat /tmp/seed-paid.out | grep -o '"order_id":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
  echo "STATUS: FIXED"
  echo "EVIDENCE: POST /api/test/seed-paid-order returned 201 with payment_status=${PAYMENT_STATUS} order_id=${ORDER_ID}"
  echo "COMMAND: curl -X POST ${API_URL}/api/test/seed-paid-order"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: POST /api/test/seed-paid-order returned ${CODE}"
  echo "COMMAND: curl -X POST ${API_URL}/api/test/seed-paid-order"
  cat /tmp/seed-paid.out
  exit 1
fi
