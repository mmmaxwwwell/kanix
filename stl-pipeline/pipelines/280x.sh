#!/usr/bin/env bash
# Normalization pipeline for models/280x.stl.
#
# Orients the raw 3D scan of the e-collar transmitter so the holster CAD
# can use a clean coordinate system:
#
#   +Z = up (antennas point up)
#   -Z = build plate (back of device sits on the bed at Z=0)
#   +X = device's long axis (back-face long edge runs along +Y after yaw)
#   +Y = antenna-toward direction (bottom of device at -Y)
#
# This is NOT a print-ready orientation; the holster is modeled around
# this oriented mesh in OpenSCAD. Do not run a slicer against the output.
#
# Run with: nix develop --command bash pipelines/280x.sh

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
SRC="${SRC:-$REPO_ROOT/models/280x.stl}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/models/normalized/280x/holster}"
INT_DIR="$OUT_DIR/intermediate"
FINAL="$OUT_DIR/280x-oriented.stl"

mkdir -p "$INT_DIR" "$(dirname "$FINAL")"

# ---- calibration ------------------------------------------------------------
# These two normals were identified interactively from stl-show-faces output
# on the raw scan (see development log). They define the part's pose:
#
#   BACK_NORMAL  — outward normal of the largest hull facet (the device's
#                  flat back panel). Rotated to point at -Z so the back
#                  sits flush on the build plate.
#   BOTTOM_NORMAL — outward normal of a hull facet on the device's bottom
#                   edge (the end opposite the antennas). Rotated to -Y
#                   so the bottom faces -Y and antennas land at +Y.
#
# YAW_DEG — residual yaw around +Z applied after the frame align, because
# the two source normals are not perfectly orthogonal and the secondary
# direction is projected. Fine-tuned interactively with stl-rotate and
# back-face long-edge fitting until the back rectangle's +X edge ran
# parallel to +Y to within 0.05°.
BACK_NORMAL="-0.178,-0.227,0.958"
BOTTOM_NORMAL="-0.982,0.107,-0.156"
YAW_DEG="2.4340"

# ---- pipeline ---------------------------------------------------------------
echo "==> [0/3] inspect raw input"
stl-inspect "$SRC"

echo "==> [1/3] align two-vector frame: back -> -Z, bottom -> -Y"
stl-align-frame "$SRC" "$INT_DIR/01-framed.stl" \
    --primary="$BACK_NORMAL"   --primary-to=0,0,-1 \
    --secondary="$BOTTOM_NORMAL" --secondary-to=0,-1,0 \
    --report

echo "==> [2/3] yaw correction around +Z (${YAW_DEG}°)"
stl-rotate "$INT_DIR/01-framed.stl" "$INT_DIR/02-yawed.stl" \
    --axis=0,0,1 --degrees="$YAW_DEG" --report

echo "==> [3/3] drop back face to Z=0"
stl-drop "$INT_DIR/02-yawed.stl" "$INT_DIR/03-dropped.stl" --report

echo "==> finalize -> $FINAL"
cp "$INT_DIR/03-dropped.stl" "$FINAL"
stl-inspect "$FINAL"
