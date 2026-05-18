#!/usr/bin/env python3
"""Rotate so a chosen plane normal points to -Z (face becomes the bottom)."""
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


def _hull_facet_candidates(m: trimesh.Trimesh):
    """Return (areas, normals) for each facet of the convex hull.

    Hull facets are by construction outward-facing planar regions, so they
    are the natural candidates for "what face should sit on the build plate."
    """
    hull = m.convex_hull
    if len(hull.facets) == 0:
        # Fallback: treat every hull triangle as its own facet.
        return hull.area_faces, hull.face_normals
    return hull.facets_area, hull.facets_normal


def pick_face_normal(m: trimesh.Trimesh, mode: str, prefer_hull: bool) -> tuple[np.ndarray, str]:
    """Return (normal, description) for the chosen reference face."""
    if mode == "hull-largest":
        areas, normals = _hull_facet_candidates(m)
        i = int(np.argmax(areas))
        return np.asarray(normals[i], dtype=float), (
            f"hull facet #{i} area={areas[i]:.3f}"
        )

    if len(m.facets) == 0:
        if mode == "largest":
            i = int(np.argmax(m.area_faces))
            return np.asarray(m.face_normals[i], dtype=float), (
                f"single-triangle (no coplanar groups) #{i} area={m.area_faces[i]:.3f}"
            )
        # lowest
        i = int(np.argmin(m.triangles_center[:, 2]))
        return np.asarray(m.face_normals[i], dtype=float), (
            f"single-triangle lowest-Z #{i}"
        )

    if mode == "largest":
        areas = np.asarray(m.facets_area, dtype=float)
        if prefer_hull:
            on_hull = np.asarray(m.facets_on_hull, dtype=bool)
            if on_hull.any():
                masked = np.where(on_hull, areas, -np.inf)
                i = int(np.argmax(masked))
                return np.asarray(m.facets_normal[i], dtype=float), (
                    f"facet #{i} (on hull) area={areas[i]:.3f}"
                )
            # No hull facets detected — fall through to plain largest.
        i = int(np.argmax(areas))
        return np.asarray(m.facets_normal[i], dtype=float), (
            f"facet #{i} area={areas[i]:.3f}"
        )

    # mode == "lowest"
    centroids_z = np.array(
        [m.triangles_center[f].mean(axis=0)[2] for f in m.facets]
    )
    i = int(np.argmin(centroids_z))
    return np.asarray(m.facets_normal[i], dtype=float), (
        f"facet #{i} lowest-Z centroid={centroids_z[i]:.3f}"
    )


def main() -> int:
    p = argparse.ArgumentParser(prog="stl-align")
    p.add_argument("input", type=Path)
    p.add_argument("output", type=Path)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument(
        "--face",
        choices=["largest", "lowest", "hull-largest"],
        help="Pick a coplanar facet automatically: "
             "'largest' = biggest mesh facet group by area; "
             "'lowest' = facet with the lowest centroid Z; "
             "'hull-largest' = biggest facet of the convex hull "
             "(guaranteed outward-facing — robust on noisy scans).",
    )
    g.add_argument(
        "--normal",
        type=str,
        metavar="X,Y,Z",
        help="Rotate so this normal points to -Z.",
    )
    p.add_argument(
        "--prefer-hull",
        action="store_true",
        help="With --face largest: restrict candidates to facets that lie on "
             "the convex hull (filters out large interior walls).",
    )
    p.add_argument(
        "--to",
        type=str,
        default="0,0,-1",
        metavar="X,Y,Z",
        help="Target direction for the chosen normal (default 0,0,-1 = down).",
    )
    p.add_argument("--report", action="store_true")
    args = p.parse_args()

    m = load_mesh(args.input)
    if args.report:
        report("input", m)

    if args.face:
        src, why = pick_face_normal(m, args.face, args.prefer_hull)
        if args.report:
            print(f"[picked] {why} normal=({src[0]:.4f},{src[1]:.4f},{src[2]:.4f})",
                  file=sys.stderr)
    else:
        src = parse_vec3(args.normal)
    dst = parse_vec3(args.to)

    R = trimesh.geometry.align_vectors(src, dst)
    m.apply_transform(R)

    if args.report:
        report("output", m)
    save_mesh(m, args.output)
    return 0


if __name__ == "__main__":
    sys.exit(main())
