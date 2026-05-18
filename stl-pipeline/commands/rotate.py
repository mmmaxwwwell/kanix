#!/usr/bin/env python3
"""Rotate by an explicit angle around an axis (right-hand rule)."""
from __future__ import annotations

import argparse
import math
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
        raise ValueError("zero rotation axis")
    return v / n


def main() -> int:
    p = argparse.ArgumentParser(prog="stl-rotate")
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument("--axis", required=True, type=str, metavar="X,Y,Z",
                   help="Rotation axis. Common: 0,0,1 = yaw around +Z, "
                        "1,0,0 = pitch around +X, 0,1,0 = roll around +Y.")
    p.add_argument("--degrees", required=True, type=float,
                   help="Rotation angle in degrees (right-hand rule).")
    p.add_argument("--report", action="store_true")
    args = p.parse_args()

    axis = parse_vec3(args.axis)
    m = load_mesh(args.input)
    if args.report:
        report("input", m)
    R = trimesh.transformations.rotation_matrix(math.radians(args.degrees), axis)
    m.apply_transform(R)
    if args.report:
        report("output", m)
    save_mesh(m, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
