#!/usr/bin/env bash
set -euo pipefail

SCAD_DIR="$(cd "$(dirname "$0")/../../scad" && pwd)"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/public/models"

mkdir -p "$OUT_DIR" "$OUT_DIR/plates"

render() {
  local scad="$1"
  local stl="$2"

  if [[ -f "$stl" && "$stl" -nt "$scad" ]]; then
    echo "Up to date: ${scad#$SCAD_DIR/}"
    return
  fi

  echo "Rendering: ${scad#$SCAD_DIR/} -> ${stl#$OUT_DIR/}"
  openscad -o "$stl" "$scad" 2>&1 | tail -5 || {
    echo "FAILED: ${scad#$SCAD_DIR/}"
    rm -f "$stl"
  }
}

# Top-level accessories: scad/*.scad -> public/models/<name>.stl
for scad in "$SCAD_DIR"/*.scad; do
  [ -f "$scad" ] || continue
  name="$(basename "$scad")"
  render "$scad" "$OUT_DIR/${name%.scad}.stl"
done

# Plate fixtures: scad/plates/*.scad -> public/models/plates/<name>.stl
for scad in "$SCAD_DIR"/plates/*.scad; do
  [ -f "$scad" ] || continue
  name="$(basename "$scad")"
  render "$scad" "$OUT_DIR/plates/${name%.scad}.stl"
done

echo "Done. STL files in $OUT_DIR"
