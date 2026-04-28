#!/usr/bin/env bash
# Verifies BUG-032 — contributor_dashboard_screen.dart no longer gates on githubLinked
set -eu

FILE="customer/lib/screens/contributor_dashboard_screen.dart"

if grep -q "githubLinked" "$FILE"; then
  echo "STATUS: STILL_BROKEN"
  echo "EVIDENCE: $FILE still references githubLinked gate"
  echo "COMMAND: grep -q githubLinked $FILE"
  exit 1
else
  echo "STATUS: FIXED"
  echo "EVIDENCE: $FILE no longer uses githubLinked as access gate"
  echo "COMMAND: grep -q githubLinked $FILE"
  exit 0
fi
