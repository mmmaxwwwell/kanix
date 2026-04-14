#!/usr/bin/env bash
set -euo pipefail

SCAD_DIR="$(cd "$(dirname "$0")/../scad" && pwd)"
FAILED=0
PASSED=0

for scad in "$SCAD_DIR"/*.scad; do
  name="$(basename "$scad")"

  tmpfile="$(mktemp /tmp/kanix-test-XXXXXX.stl)"
  if openscad -o "$tmpfile" "$scad" 2>&1; then
    if [[ -s "$tmpfile" ]]; then
      echo "PASS: $name"
      PASSED=$((PASSED + 1))
    else
      echo "FAIL: $name (empty output)"
      FAILED=$((FAILED + 1))
    fi
  else
    echo "FAIL: $name (compilation error)"
    FAILED=$((FAILED + 1))
  fi
  rm -f "$tmpfile"
done

echo ""
echo "Results: $PASSED passed, $FAILED failed"

if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
