#!/usr/bin/env bash
# scripts/e2e-run-patrol.sh — Run Patrol integration tests and emit structured JSON
# Usage: scripts/e2e-run-patrol.sh <admin|customer> [test_file]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="$PROJECT_ROOT/test-logs/e2e"

APP="${1:?Usage: e2e-run-patrol.sh <admin|customer> [test_file]}"
TEST_FILE="${2:-integration_test/smoke_test.dart}"

if [[ "$APP" != "admin" && "$APP" != "customer" ]]; then
  echo "ERROR: first argument must be 'admin' or 'customer'" >&2
  exit 1
fi

APP_DIR="$PROJECT_ROOT/$APP"
mkdir -p "$LOGS_DIR"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
JSON_OUT="$LOGS_DIR/patrol-${APP}-${TIMESTAMP}.json"
RAW_LOG="$LOGS_DIR/patrol-${APP}-${TIMESTAMP}.log"

echo "[e2e-patrol] Running integration tests for $APP..."
echo "[e2e-patrol] Test file: $TEST_FILE"
echo "[e2e-patrol] JSON output: $JSON_OUT"

EXIT_CODE=0
cd "$APP_DIR"
flutter test "$TEST_FILE" --machine 2>"$RAW_LOG" | tee "$LOGS_DIR/patrol-${APP}-raw.json" || EXIT_CODE=$?

# Write structured JSON summary
cat > "$JSON_OUT" <<JSONEOF
{
  "app": "$APP",
  "test_file": "$TEST_FILE",
  "timestamp": "$TIMESTAMP",
  "exit_code": $EXIT_CODE,
  "raw_log": "patrol-${APP}-${TIMESTAMP}.log",
  "machine_output": "patrol-${APP}-raw.json"
}
JSONEOF

echo "[e2e-patrol] Results written to $JSON_OUT (exit code: $EXIT_CODE)"
exit "$EXIT_CODE"
