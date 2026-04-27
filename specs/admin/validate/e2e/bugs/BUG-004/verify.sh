#!/usr/bin/env bash
# Verifies BUG-004 — fulfillment list API respects ?limit= and Flutter provider requests limit=100
set -eu

# Check 1: DB query function uses .limit()
if ! grep -q "\.limit(pageLimit)" api/src/db/queries/fulfillment-task.ts 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: listFulfillmentTasks in DB query does not call .limit() — all rows still fetched"
  echo "COMMAND: grep '.limit' api/src/db/queries/fulfillment-task.ts"
  exit 1
fi

# Check 2: Flutter provider passes limit param
if ! grep -q "'limit': 100" admin/lib/providers/fulfillment_provider.dart 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: fulfillmentListProvider does not pass limit=100 to the API"
  echo "COMMAND: grep 'limit' admin/lib/providers/fulfillment_provider.dart"
  exit 1
fi

# Check 3: API endpoint accepts limit param
if ! grep -q "limit.*offset" api/src/server.ts 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: /api/admin/fulfillment-tasks route does not accept limit/offset params"
  echo "COMMAND: grep 'limit' api/src/server.ts"
  exit 1
fi

echo "STATUS: FIXED"
echo "EVIDENCE: DB query uses .limit(pageLimit), Flutter provider requests limit=100, API exposes limit/offset params"
echo "COMMAND: grep '.limit(pageLimit)' api/src/db/queries/fulfillment-task.ts"
exit 0
