#!/usr/bin/env bash
# Verifies BUG-035 — donationEnabled is present in the API dashboard response
# and the Flutter APK contains the post-fix donation UI strings.
set -eu
source test/e2e/.state/env 2>/dev/null || true

# Step 1: verify API returns donationEnabled in dashboard response
RESP=$(curl -s -f \
  -H "Cookie: ${CONTRIBUTOR_COOKIE:-}" \
  "${API_URL:-http://localhost:3000}/api/contributors/dashboard" 2>/dev/null || echo "CURL_FAIL")

if echo "$RESP" | grep -q "CURL_FAIL"; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: Could not reach API — no CONTRIBUTOR_COOKIE or API_URL set"
  echo "COMMAND: curl \$API_URL/api/contributors/dashboard"
  exit 2
fi

DONATION=$(echo "$RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
val = d.get('dashboard', {}).get('donationEnabled', 'MISSING')
print(val)
" 2>/dev/null || echo "PARSE_FAIL")

if [ "$DONATION" = "MISSING" ] || [ "$DONATION" = "PARSE_FAIL" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: donationEnabled absent from API dashboard response"
  echo "COMMAND: curl \$API_URL/api/contributors/dashboard | jq .dashboard.donationEnabled"
  exit 1
fi

# Step 2: check APK contains donation UI strings
APK=$(find customer/build/app/outputs -name '*-debug.apk' 2>/dev/null | head -1 || true)
if [ -z "$APK" ]; then
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: API donationEnabled=$DONATION present; APK not built yet — rebuild required"
  echo "COMMAND: cd customer && flutter clean && flutter build apk --debug"
  exit 2
fi

if unzip -p "$APK" assets/flutter_assets/kernel_blob.bin 2>/dev/null \
     | strings | grep -q 'Donate royalties to charity'; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: API donationEnabled=$DONATION; APK contains donation section UI"
  echo "COMMAND: unzip -p \$APK assets/flutter_assets/kernel_blob.bin | strings | grep 'Donate royalties'"
  exit 0
else
  echo "STATUS: INCONCLUSIVE"
  echo "EVIDENCE: API donationEnabled=$DONATION OK; APK does not contain donation UI — stale build"
  echo "COMMAND: cd customer && flutter clean && flutter build apk --debug && adb install -r build/app/outputs/flutter-apk/app-debug.apk"
  exit 2
fi
