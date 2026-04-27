#!/usr/bin/env bash
# Verifies BUG-004b — Dashboard stat cards no longer overflow their containers
set -eu

SCREEN="admin/lib/screens/dashboard_screen.dart"

# Check that the old too-flat ratio (2.5) is gone
if grep -q "childAspectRatio: 2.5" "$SCREEN" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $SCREEN still uses childAspectRatio: 2.5 (too flat for headlineMedium content)"
  echo "COMMAND: grep childAspectRatio $SCREEN"
  exit 1
fi

# Check that a reasonable ratio is set
if ! grep -qE "childAspectRatio: (1\.[0-9]|2\.[0-4])" "$SCREEN" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $SCREEN childAspectRatio not set to a safe value"
  echo "COMMAND: grep childAspectRatio $SCREEN"
  exit 1
fi

# Check that mainAxisSize: MainAxisSize.min is present
if ! grep -q "mainAxisSize: MainAxisSize.min" "$SCREEN" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $SCREEN missing mainAxisSize: MainAxisSize.min on Column"
  echo "COMMAND: grep mainAxisSize $SCREEN"
  exit 1
fi

# Check that TextOverflow.ellipsis is present
if ! grep -q "TextOverflow.ellipsis" "$SCREEN" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $SCREEN missing TextOverflow.ellipsis on title Text"
  echo "COMMAND: grep TextOverflow $SCREEN"
  exit 1
fi

RATIO=$(grep -oE "childAspectRatio: [0-9.]+" "$SCREEN" | head -1)
echo "STATUS: FIXED"
echo "EVIDENCE: $SCREEN uses $RATIO + mainAxisSize.min + TextOverflow.ellipsis (all overflow guards present)"
echo "COMMAND: grep -E 'childAspectRatio|mainAxisSize|TextOverflow' $SCREEN"
exit 0
