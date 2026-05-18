#!/usr/bin/env python3
"""Translate a mesh so a chosen axis-bound sits at a given value (default: min Z = 0)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ._stl_io import load_mesh, save_mesh, report


def main() -> int:
    p = argparse.ArgumentParser(prog="stl-drop")
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    p.add_argument(
        "--axis", choices=["x", "y", "z"], default="z",
        help="Axis to drop (default: z).",
    )
    p.add_argument(
        "--side", choices=["min", "max"], default="min",
        help="Which bound to pin (default: min).",
    )
    p.add_argument(
        "--value", type=float, default=0.0,
        help="Target value for the pinned bound (default: 0).",
    )
    p.add_argument("--report", action="store_true")
    args = p.parse_args()

    m = load_mesh(args.input)
    if args.report:
        report("input", m)

    idx = {"x": 0, "y": 1, "z": 2}[args.axis]
    row = 0 if args.side == "min" else 1
    current = float(m.bounds[row, idx])
    delta = [0.0, 0.0, 0.0]
    delta[idx] = args.value - current
    m.apply_translation(delta)

    if args.report:
        report("output", m)
    save_mesh(m, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
