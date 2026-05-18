#!/usr/bin/env python3
"""Print mesh stats: bounds, extents, centroid, volume, watertightness."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ._stl_io import load_mesh


def main() -> int:
    p = argparse.ArgumentParser(prog="stl-inspect")
    p.add_argument("input", type=Path)
    args = p.parse_args()

    m = load_mesh(args.input)
    b = m.bounds
    e = m.extents
    c = m.centroid
    print(f"path:       {args.input}")
    print(f"vertices:   {len(m.vertices)}")
    print(f"faces:      {len(m.faces)}")
    print(f"bounds_min: {b[0,0]:.4f} {b[0,1]:.4f} {b[0,2]:.4f}")
    print(f"bounds_max: {b[1,0]:.4f} {b[1,1]:.4f} {b[1,2]:.4f}")
    print(f"extents:    {e[0]:.4f} {e[1]:.4f} {e[2]:.4f}")
    print(f"centroid:   {c[0]:.4f} {c[1]:.4f} {c[2]:.4f}")
    print(f"watertight: {m.is_watertight}")
    try:
        print(f"volume:     {m.volume:.4f}")
    except Exception:
        print("volume:     n/a (not watertight)")
    print(f"facets:     {len(m.facets)} coplanar groups")
    if len(m.facets) > 0:
        i = int(max(range(len(m.facets)), key=lambda j: m.facets_area[j]))
        n = m.facets_normal[i]
        print(f"largest_facet_area:   {m.facets_area[i]:.4f}")
        print(f"largest_facet_normal: {n[0]:.4f} {n[1]:.4f} {n[2]:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
