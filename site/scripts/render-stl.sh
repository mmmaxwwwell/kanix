#!/usr/bin/env bash
set -euo pipefail

SCAD_DIR="$(cd "$(dirname "$0")/../../scad" && pwd)"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/models"

# Library-only files that should not be rendered
SKIP=("common.scad" "hinge.scad")

mkdir -p "$OUT_DIR"

should_skip() {
  local file="$1"
  for s in "${SKIP[@]}"; do
    [[ "$file" == "$s" ]] && return 0
  done
  return 1
}

for scad in "$SCAD_DIR"/*.scad; do
  name="$(basename "$scad")"
  if should_skip "$name"; then
    echo "Skipping library file: $name"
    continue
  fi

  stl="$OUT_DIR/${name%.scad}.stl"

  if [[ -f "$stl" && "$stl" -nt "$scad" ]]; then
    echo "Up to date: $name"
    continue
  fi

  echo "Rendering: $name -> ${name%.scad}.stl"
  openscad -o "$stl" "$scad" 2>&1 | tail -5 || {
    echo "FAILED: $name"
    rm -f "$stl"
  }
done

echo "Done. STL files in $OUT_DIR"
