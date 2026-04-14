#!/usr/bin/env bash
set -euo pipefail

DIST_DIR="$(cd "$(dirname "$0")/../dist" && pwd)"
BASE="/kanix"
RESULTS_FILE="$(mktemp)"
echo "0 0" > "$RESULTS_FILE"

check_path() {
  local ref="$1"
  local source="$2"

  # Skip external links, anchors, mailto, javascript, data URIs
  if [[ "$ref" =~ ^(https?://|mailto:|javascript:|#|data:) ]]; then
    return
  fi

  # Strip query string and anchor
  local clean="${ref%%\?*}"
  clean="${clean%%#*}"

  # Strip base prefix
  local relative
  if [[ "$clean" == "$BASE/"* ]]; then
    relative="${clean#$BASE}"
  elif [[ "$clean" == "$BASE" ]]; then
    relative="/"
  elif [[ "$clean" == /* ]]; then
    relative="$clean"
  else
    return
  fi

  local target="$DIST_DIR$relative"

  # If path ends in / or has no extension, check for index.html
  if [[ "$target" == */ ]]; then
    target="${target}index.html"
  elif [[ "$(basename "$target")" != *.* ]]; then
    target="${target}/index.html"
  fi

  local counts
  counts="$(cat "$RESULTS_FILE")"
  local checked="${counts% *}"
  local failed="${counts#* }"
  checked=$((checked + 1))

  if [[ ! -f "$target" ]]; then
    echo "BROKEN: $ref (from $source)"
    failed=$((failed + 1))
  fi

  echo "$checked $failed" > "$RESULTS_FILE"
}

# Collect all refs from HTML files
for html in $(find "$DIST_DIR" -name "*.html" | sort); do
  relative="${html#$DIST_DIR}"

  # Extract href, src, and data-stl-path values
  grep -oP '(?:href|src|data-stl-path)="[^"]*"' "$html" 2>/dev/null | while IFS= read -r match; do
    ref="${match#*=\"}"
    ref="${ref%\"}"
    check_path "$ref" "$relative"
  done
done

counts="$(cat "$RESULTS_FILE")"
CHECKED="${counts% *}"
FAILED="${counts#* }"
rm -f "$RESULTS_FILE"

echo ""
echo "Checked $CHECKED internal links. $FAILED broken."

if [[ "$FAILED" -gt 0 ]]; then
  exit 1
fi
