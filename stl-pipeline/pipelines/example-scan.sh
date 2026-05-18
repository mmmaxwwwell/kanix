#!/usr/bin/env bash
# Per-object normalization pipeline.
#
# Each object should have its own copy of this script with the parameters
# tuned to that scan. Intermediate STLs are kept so each stage can be
# inspected in a slicer.
#
# Run from inside `nix develop` (which puts stl-* commands on PATH), or
# invoke with `nix develop --command bash pipelines/example-scan.sh`.

set -euo pipefail

# ---- inputs / outputs --------------------------------------------------------
# Inputs must come from the repo's top-level models/ folder (raw 3D scans).
# Outputs go to models/normalized/ so raw and normalized stay separate.
REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
SRC="${SRC:-$REPO_ROOT/models/example.stl}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/models/normalized/example}"
INT_DIR="$OUT_DIR/intermediate"
FINAL="$OUT_DIR/example-normalized.stl"

mkdir -p "$INT_DIR" "$(dirname "$FINAL")"

# ---- parameters (tune per object) -------------------------------------------
# Pick the planar facet to flatten to the build plate.
ALIGN_FACE="largest"     # or "lowest"

# Scale so the longest axis is this many mm. Replace with --feature
# (MEASURED=ACTUAL) once you have a calibration measurement.
SCALE_LONGEST_MM="100"

# Centering: xy keeps the part on the bed and recenters horizontally.
CENTER_AXES="xy"

# ---- pipeline ---------------------------------------------------------------
echo "==> [0/5] inspect raw input"
stl-inspect "$SRC"

echo "==> [1/5] align $ALIGN_FACE facet to -Z"
stl-align "$SRC" "$INT_DIR/01-aligned.stl" --face "$ALIGN_FACE" --report

echo "==> [2/5] scale longest axis to ${SCALE_LONGEST_MM}mm"
stl-scale "$INT_DIR/01-aligned.stl" "$INT_DIR/02-scaled.stl" \
    --longest "$SCALE_LONGEST_MM" --report

echo "==> [3/5] center on $CENTER_AXES"
stl-center "$INT_DIR/02-scaled.stl" "$INT_DIR/03-centered.stl" \
    --axes "$CENTER_AXES" --report

echo "==> [4/5] drop min Z to 0"
stl-drop "$INT_DIR/03-centered.stl" "$INT_DIR/04-dropped.stl" --report

echo "==> [5/5] finalize -> $FINAL"
cp "$INT_DIR/04-dropped.stl" "$FINAL"
stl-inspect "$FINAL"
