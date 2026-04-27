#!/usr/bin/env bash
# Verifies BUG-001 — POST /auth/signin no longer returns 500 for valid JSON body.
# The bug was that FastifyError (e.g. FST_ERR_CTP_INVALID_JSON_BODY with statusCode:400)
# fell through to the 500 catch-all in error-handler.ts instead of returning its own statusCode.
set -euo pipefail

API_URL="${API_URL:-http://127.0.0.1:3000}"

# Test: valid JSON body with properly escaped special chars → must NOT return 500.
# Use heredoc to avoid shell history-expansion of '!' in the password.
HTTP_CODE=$(curl -s -o /tmp/bug001-resp.json -w '%{http_code}' \
  -X POST "$API_URL/auth/signin" \
  -H 'Content-Type: application/json' \
  -d @- <<'JSON'
{"formFields":[{"id":"email","value":"admin@kanix.test"},{"id":"password","value":"TestAdmin123!"}]}
JSON
)

if [ "$HTTP_CODE" = "500" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: POST /auth/signin returned 500 — FastifyError still misclassified as internal error"
  echo "COMMAND: curl -X POST $API_URL/auth/signin -H 'Content-Type: application/json' -d '{...}'"
  cat /tmp/bug001-resp.json 2>/dev/null || true
  exit 1
fi

# 200 = auth succeeded; 401/400/WRONG_CREDENTIALS_ERROR = auth reached SuperTokens (also fixed)
echo "STATUS: FIXED"
echo "EVIDENCE: POST /auth/signin returned $HTTP_CODE (not 500) — FastifyError correctly classified"
echo "COMMAND: curl -X POST $API_URL/auth/signin -H 'Content-Type: application/json' -d '{formFields:[...]}'"
exit 0
