#!/usr/bin/env bash
# Verifies BUG-034 — clawedBackMinor is present in the API dashboard response
# and the Flutter APK contains the post-fix symbol 'Clawed Back'.
set -eu
source test/e2e/.state/env 2>/dev/null || true

# Step 1: verify API returns clawedBackMinor in royaltySummary
RESP=$(curl -s -f \
  -H "Cookie: ${CONTRIBUTOR_COOKIE:-}" \
  "${API_URL:-http://localhost:3000}/api/contributors/dashboard" 2>/dev/null || echo "CURL_FAIL")

if echo "$RESP" | grep -q "CURL_FAIL"; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: Could not reach API — no CONTRIBUTOR_COOKIE or API_URL set"
  echo "COMMAND: curl \$API_URL/api/contributors/dashboard"
  exit 2
fi

CLAWED=$(echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('dashboard', {}).get('royaltySummary', {}).get('clawedBackMinor', 'MISSING'))
" 2>/dev/null || echo "PARSE_FAIL")

if [ "$CLAWED" = "MISSING" ] || [ "$CLAWED" = "PARSE_FAIL" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: royaltySummary.clawedBackMinor absent from API response"
  echo "COMMAND: curl \$API_URL/api/contributors/dashboard | jq .dashboard.royaltySummary"
  exit 1
fi

# Step 2: check APK contains 'Clawed Back' label (UI fix)
APK=$(find customer/build/app/outputs -name '*-debug.apk' 2>/dev/null | head -1 || true)
if [ -z "$APK" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: API clawedBackMinor=$CLAWED present; APK not built yet — rebuild required"
  echo "COMMAND: cd customer && flutter clean && flutter build apk --debug"
  exit 2
fi

if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q 'Clawed Back'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: API clawedBackMinor=$CLAWED; APK kernel_blob.bin contains 'Clawed Back' label"
  echo "COMMAND: unzip -p \$APK assets/flutter_assets/kernel_blob.bin | strings | grep 'Clawed Back'"
  exit 0
else
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: API clawedBackMinor=$CLAWED OK; APK does not contain 'Clawed Back' — stale build"
  echo "COMMAND: cd customer && flutter clean && flutter build apk --debug && adb install -r build/app/outputs/flutter-apk/app-debug.apk"
  exit 2
fi
