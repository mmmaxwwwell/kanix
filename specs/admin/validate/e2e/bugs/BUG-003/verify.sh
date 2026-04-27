#!/usr/bin/env bash
# Verifies BUG-003 — shipments_screen.dart sends {new_status} not {status} to transition
set -eu

SCREEN="admin/lib/screens/shipments_screen.dart"

# Check the _markShipped method sends 'new_status', not 'status'
if grep -q "'status': 'shipped'" "$SCREEN" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $SCREEN still sends {'status': 'shipped'} (API expects {'new_status': 'shipped'})"
  echo "COMMAND: grep -n status $SCREEN"
  exit 1
fi

if grep -q "'new_status': 'shipped'" "$SCREEN" 2>/dev/null; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: $SCREEN sends {'new_status': 'shipped'} matching API schema"
  echo "COMMAND: grep new_status $SCREEN"
  exit 0
fi

echo "STATUS: STILL_BROKEN"
echo "EVIDENCE: $SCREEN does not contain expected new_status field for shipped transition"
echo "COMMAND: grep -n shipped $SCREEN"
exit 1
