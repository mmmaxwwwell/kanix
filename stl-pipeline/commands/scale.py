#!/usr/bin/env python3
"""Scale a mesh by factor, longest-axis target, bounding box, or feature ratio."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from ._stl_io import load_mesh, save_mesh, report


def parse_box(s: str) -> np.ndarray:
    parts = [float(x) for x in s.lower().split("x")]
    if len(parts) != 3:
        raise ValueError(f"expected WxHxD, got {s!r}")
    return np.array(parts, dtype=float)


def main() -> int:
    p = argparse.ArgumentParser(prog="stl-scale")
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--factor", type=float, help="Uniform scale factor.")
    g.add_argument(
        "--longest", type=float, metavar="MM",
        help="Uniformly scale so the longest axis equals MM.",
    )
    g.add_argument(
        "--fit", type=str, metavar="WxHxD",
        help="Uniformly scale to fit inside this box (mm).",
    )
    g.add_argument(
        "--feature", type=str, metavar="MEASURED=ACTUAL",
        help="Scale by ACTUAL/MEASURED. Example: '41.2=38' if a known "
             "38mm feature measures 41.2mm in the scan.",
    )
    p.add_argument("--report", action="store_true")
    args = p.parse_args()

    m = load_mesh(args.input)
    if args.report:
        report("input", m)

    if args.factor is not None:
        factor = args.factor
    elif args.longest is not None:
        longest = float(m.extents.max())
        if longest == 0:
            print("error: mesh has zero extent", file=sys.stderr)
            return 1
        factor = args.longest / longest
    elif args.fit is not None:
        target = parse_box(args.fit)
        factor = float((target / m.extents).min())
    else:  # feature
        measured_s, actual_s = args.feature.split("=", 1)
        measured = float(measured_s)
        actual = float(actual_s)
        if measured == 0:
            print("error: measured value cannot be zero", file=sys.stderr)
            return 2
        factor = actual / measured

    m.apply_scale(factor)
    print(f"applied scale factor: {factor:.6f}", file=sys.stderr)

    if args.report:
        report("output", m)
    save_mesh(m, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
