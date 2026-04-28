#!/usr/bin/env bash
# Verifies BUG-031 — account_screen.dart contains context.go('/contributor') call
set -eu

FILE="customer/lib/screens/account_screen.dart"

if grep -q "go('/contributor')" "$FILE"; then
  echo "STATUS: FIXED"
  echo "EVIDENCE: $FILE contains context.go('/contributor') navigation call"
  echo "COMMAND: grep -q \"go('/contributor')\" $FILE"
  exit 0
else
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $FILE does not contain context.go('/contributor')"
  echo "COMMAND: grep -q \"go('/contributor')\" $FILE"
  exit 1
fi
