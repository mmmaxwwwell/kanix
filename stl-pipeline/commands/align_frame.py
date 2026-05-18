#!/usr/bin/env python3
"""Rotate so two source directions map to two target directions simultaneously.

Use this when a single normal is not enough to fix the orientation — e.g.
the back face fixes pitch+roll but yaw is still arbitrary. Specifying a
second non-parallel direction (e.g. the bottom face) pins the remaining
rotation completely.

Example:
  stl-align-frame in.stl out.stl \\
    --primary=-0.178,-0.227,0.958 --primary-to=0,0,-1 \\
    --secondary=0.733,0.188,-0.653 --secondary-to=0,-1,0

The primary mapping is exact; the secondary is projected into the plane
perpendicular to the primary target before constructing the rotation, so
the two source directions don't need to be orthogonal.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import trimesh

from ._stl_io import load_mesh, save_mesh, report


def parse_vec3(s: str) -> np.ndarray:
    parts = [float(x) for x in s.split(",")]
    if len(parts) != 3:
        raise ValueError(f"expected 3 comma-separated numbers, got {s!r}")
    v = np.array(parts, dtype=float)
    n = np.linalg.norm(v)
    if n == 0:
        raise ValueError("zero vector")
    return v / n


def build_frame(primary: np.ndarray, secondary: np.ndarray) -> np.ndarray:
    """Return a 3x3 right-handed orthonormal frame.

    Column 0 = primary direction (kept exact).
    Column 1 = secondary projected to be orthogonal to primary, normalized.
    Column 2 = primary x secondary_projected.
    """
    e0 = primary / np.linalg.norm(primary)
    s = secondary - np.dot(secondary, e0) * e0
    s_norm = np.linalg.norm(s)
    if s_norm < 1e-9:
        raise ValueError(
            "secondary direction is parallel to primary; pick a non-parallel pair"
        )
    e1 = s / s_norm
    e2 = np.cross(e0, e1)
    return np.column_stack([e0, e1, e2])


def main() -> int:
    p = argparse.ArgumentParser(prog="stl-align-frame")
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--primary", required=True, type=str, metavar="X,Y,Z",
                   help="Primary source direction in the input mesh's frame.")
    p.add_argument("--primary-to", required=True, type=str, metavar="X,Y,Z",
                   help="Where the primary direction should point after rotation.")
    p.add_argument("--secondary", required=True, type=str, metavar="X,Y,Z",
                   help="Secondary source direction (non-parallel to primary).")
    p.add_argument("--secondary-to", required=True, type=str, metavar="X,Y,Z",
                   help="Where the secondary direction should point after rotation.")
    p.add_argument("--report", action="store_true")
    args = p.parse_args()

    src_primary = parse_vec3(args.primary)
    src_secondary = parse_vec3(args.secondary)
    dst_primary = parse_vec3(args.primary_to)
    dst_secondary = parse_vec3(args.secondary_to)

    src_frame = build_frame(src_primary, src_secondary)
    dst_frame = build_frame(dst_primary, dst_secondary)

    # Rotation R such that R @ src_frame = dst_frame  ->  R = dst_frame @ src_frame.T
    R3 = dst_frame @ src_frame.T

    # Sanity check: should be a proper rotation (det = +1).
    det = float(np.linalg.det(R3))
    if abs(det - 1.0) > 1e-6:
        print(f"warning: rotation determinant = {det:.6f} (expected +1)",
              file=sys.stderr)

    R4 = np.eye(4)
    R4[:3, :3] = R3

    m = load_mesh(args.input)
    if args.report:
        report("input", m)
    m.apply_transform(R4)
    if args.report:
        report("output", m)
        # Show where the source directions actually landed.
        landed_primary = R3 @ src_primary
        landed_secondary = R3 @ src_secondary
        proj_secondary = landed_secondary - np.dot(landed_secondary, dst_primary) * dst_primary
        proj_secondary /= max(np.linalg.norm(proj_secondary), 1e-12)
        err_primary = float(np.degrees(np.arccos(np.clip(np.dot(landed_primary, dst_primary), -1, 1))))
        err_secondary = float(np.degrees(np.arccos(np.clip(np.dot(proj_secondary, dst_secondary), -1, 1))))
        print(f"[primary landed]   ({landed_primary[0]:+.4f},{landed_primary[1]:+.4f},{landed_primary[2]:+.4f}) "
              f"err={err_primary:.3f}°", file=sys.stderr)
        print(f"[secondary landed] ({landed_secondary[0]:+.4f},{landed_secondary[1]:+.4f},{landed_secondary[2]:+.4f}) "
              f"err_in_plane={err_secondary:.3f}°", file=sys.stderr)

    save_mesh(m, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
