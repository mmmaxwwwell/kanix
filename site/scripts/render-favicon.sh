#!/usr/bin/env bash
# Renders the public/favicon.png from logo1.svg.
#
# Recipe: rasterize the source logo (the SVG embeds a raster of a black dog
# silhouette on an amber background), threshold the dark pixels into a binary
# mask, paint that mask amber, and center it on a solid black tile.
#
# The result: amber dog silhouette on a black background.
#
# Requires ImageMagick 7+ (`magick`).
#
# Usage:
#   bash scripts/render-favicon.sh                  # default 64x64
#   bash scripts/render-favicon.sh 128              # custom size

set -euo pipefail

SIZE="${1:-64}"
INSET=$(( SIZE - SIZE / 8 ))      # ~12.5% inset so the artwork doesn't touch edges
AMBER="#f59e0b"
BG="#000000"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/logo1.svg"
OUT="$ROOT/site/public/favicon.png"

if [[ ! -f "$SRC" ]]; then
  echo "error: source logo not found at $SRC" >&2
  exit 1
fi

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick (magick) not on PATH; enter the dev shell first" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 1. Rasterize the logo at the inset size with no alpha. The SVG embeds a
#    raster image that fills the frame (black dog on amber), so the result
#    is opaque RGB pixels we can threshold.
magick "$SRC" -resize "${INSET}x${INSET}" -alpha off "$TMP/raster.png"

# 2. Build a mask: dark pixels (the dog) become white, the amber background
#    becomes black. The negate flips it so the dog ends up white in the mask.
magick "$TMP/raster.png" -colorspace Gray -threshold 50% -negate "$TMP/mask.png"

# 3. Paint an amber tile, use the dog mask as its opacity, then center the
#    result on a solid black canvas.
magick \
  \( -size "${INSET}x${INSET}" "xc:$AMBER" "$TMP/mask.png" -alpha off -compose CopyOpacity -composite \) \
  -compose Over -gravity center -background "$BG" -extent "${SIZE}x${SIZE}" \
  "$OUT"

echo "rendered $OUT (${SIZE}x${SIZE}, inset ${INSET})"
