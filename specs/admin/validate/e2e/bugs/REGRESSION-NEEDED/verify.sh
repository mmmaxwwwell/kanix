#!/usr/bin/env bash
# REGRESSION-NEEDED — verifies T104b_test.dart exists and covers warranty claim navigation
set -eu

TEST_FILE="customer/integration_test/T104b_test.dart"

# Check regression test file was written
if [ ! -f "$TEST_FILE" ]; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $TEST_FILE does not exist"
  echo "COMMAND: ls $TEST_FILE"
  exit 1
fi

# Check test covers Support tab navigation (BUG-002 regression guard)
if ! grep -q "Support" "$TEST_FILE" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $TEST_FILE does not test Support tab (BUG-002 regression guard missing)"
  echo "COMMAND: grep Support $TEST_FILE"
  exit 1
fi

# Check test covers warranty claim validation logic (T104b flow)
if ! grep -q "isWithinWarranty" "$TEST_FILE" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $TEST_FILE does not test isWithinWarranty logic (warranty claim behavioral test missing)"
  echo "COMMAND: grep isWithinWarranty $TEST_FILE"
  exit 1
fi

echo "STATUS: FIXED"
echo "EVIDENCE: $TEST_FILE exists and contains Support tab and warranty validity behavioral tests"
echo "COMMAND: grep -c 'testWidgets' $TEST_FILE"
exit 0
