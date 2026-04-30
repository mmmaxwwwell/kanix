#!/usr/bin/env bash
# Verifies BUG-002 — Support tab added to customer app bottom nav bar
set -eu

APP_SHELL="customer/lib/widgets/app_shell.dart"

# Check Support destination exists in nav bar
if ! grep -q "label: 'Support'" "$APP_SHELL" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: Support destination not found in $APP_SHELL"
  echo "COMMAND: grep \"label: 'Support'\" $APP_SHELL"
  exit 1
fi

# Check /support is in the _routes list (so tapping Support tab navigates there)
if ! grep -q "'/support'" "$APP_SHELL" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: /support route not in _routes list in $APP_SHELL"
  echo "COMMAND: grep /support $APP_SHELL"
  exit 1
fi

# Check /warranty still maps to the Support tab index
if ! grep -q "startsWith('/warranty')" "$APP_SHELL" 2>/dev/null; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: /warranty route not mapped to Support tab in $APP_SHELL"
  echo "COMMAND: grep warranty $APP_SHELL"
  exit 1
fi

echo "STATUS: FIXED"
echo "EVIDENCE: $APP_SHELL has Support destination, /support in _routes, and /warranty mapped to Support tab"
echo "COMMAND: grep -n \"Support\\|/support\\|/warranty\" $APP_SHELL"
exit 0
