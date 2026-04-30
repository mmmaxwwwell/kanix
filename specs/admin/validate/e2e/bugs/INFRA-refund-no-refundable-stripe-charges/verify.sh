#!/usr/bin/env bash
# Verifies INFRA-refund-no-refundable-stripe-charges — a refundable order exists
# and POST /api/admin/orders/<id>/refunds returns 2xx (not 502).
set -eu

# Use the seeded order ID written by setup.sh, or fall back to querying the DB.
ORDER_ID="${E2E_REFUNDABLE_ORDER_ID:-}"

if [ -z "$ORDER_ID" ]; then
  # Try to find it from the DB via psql
  if command -v psql >/dev/null 2>&1; then
    ORDER_ID=$(psql -h 127.0.0.1 -U kanix -d kanix -t -c \
      "SELECT id FROM \"order\" WHERE order_number='E2E-SEED-REFUNDABLE-001' LIMIT 1;" \
      2>/dev/null | tr -d ' \n')
  fi
fi

if [ -z "$ORDER_ID" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: E2E_REFUNDABLE_ORDER_ID not set and could not query DB for E2E-SEED-REFUNDABLE-001"
  echo "COMMAND: psql -h 127.0.0.1 -U kanix -d kanix -c \"SELECT id FROM order WHERE order_number='E2E-SEED-REFUNDABLE-001'\""
  exit 2
fi

if [ -z "${API_URL:-}" ]; then
  API_URL="http://127.0.0.1:3000"
fi

# POST a small refund to confirm the API can refund this order
CODE=$(curl -s -o /tmp/refund-verify.out -w '%{http_code}' \
  -X POST "${API_URL}/api/admin/orders/${ORDER_ID}/refunds" \
  -H 'Content-Type: application/json' \
  -H "${ADMIN_COOKIE:+Cookie: $ADMIN_COOKIE}" \
  -d '{"amount":100,"reason":"e2e-verify-refund"}')

if [ "$CODE" = "200" ] || [ "$CODE" = "201" ]; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: POST /api/admin/orders/${ORDER_ID}/refunds returned ${CODE}"
  echo "COMMAND: curl -X POST ${API_URL}/api/admin/orders/${ORDER_ID}/refunds"
  exit 0
elif [ "$CODE" = "401" ] || [ "$CODE" = "403" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: Refund endpoint returned ${CODE} (auth required — need ADMIN_COOKIE)"
  echo "COMMAND: curl -X POST ${API_URL}/api/admin/orders/${ORDER_ID}/refunds"
  exit 2
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: POST /api/admin/orders/${ORDER_ID}/refunds returned ${CODE}"
  echo "COMMAND: curl -X POST ${API_URL}/api/admin/orders/${ORDER_ID}/refunds"
  cat /tmp/refund-verify.out 2>/dev/null || true
  exit 1
fi
