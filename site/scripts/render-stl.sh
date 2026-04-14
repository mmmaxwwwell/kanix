#!/usr/bin/env bash
set -euo pipefail

SCAD_DIR="$(cd "$(dirname "$0")/../../scad" && pwd)"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/models"

mkdir -p "$OUT_DIR"

for scad in "$SCAD_DIR"/*.scad; do
  name="$(basename "$scad")"
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
