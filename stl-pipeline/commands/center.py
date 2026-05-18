#!/usr/bin/env python3
"""Translate a mesh so its bounding-box center sits on chosen axes."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ._stl_io import load_mesh, save_mesh, report


def main() -> int:
    p = argparse.ArgumentParser(prog="stl-center")
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument(
        "--axes",
        choices=["xy", "xyz", "x", "y", "z"],
        default="xy",
        help="Which axes to center on the origin (default: xy).",
    )
    p.add_argument(
        "--use",
        choices=["bounds", "centroid"],
        default="bounds",
        help="Center using bounding-box midpoint (default) or mesh centroid. "
             "Bounds is symmetric to the shape; centroid is mass-weighted.",
    )
    p.add_argument("--report", action="store_true")
    args = p.parse_args()

    m = load_mesh(args.input)
    if args.report:
        report("input", m)

    c = m.bounds.mean(axis=0) if args.use == "bounds" else m.centroid
    mask = {
        "x":   [1, 0, 0],
        "y":   [0, 1, 0],
        "z":   [0, 0, 1],
        "xy":  [1, 1, 0],
        "xyz": [1, 1, 1],
    }[args.axes]
    delta = [-c[i] * mask[i] for i in range(3)]
    m.apply_translation(delta)

    if args.report:
        report("output", m)
    save_mesh(m, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
