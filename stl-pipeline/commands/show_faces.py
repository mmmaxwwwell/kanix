#!/usr/bin/env python3
"""Export a colored mesh (PLY by default) highlighting candidate faces.

Open the resulting .ply in VSCode with the "3D Viewer" extension
(slevesque.vscode-3dviewer). The viewer reloads on file change, so
re-running this command after tweaking parameters gives a hot-reload
preview loop. PLY natively supports per-face colors in a single file.

Output format is chosen from the file suffix: .ply (recommended),
.glb (smaller, but viewer support varies), .obj (writes a sidecar .mtl).

Color scheme (one hue family per mode, rank-0 most saturated):
  --mode hull-largest -> RED family
  --mode mesh-largest -> BLUE family
  base mesh           -> light gray

A legend is printed to stdout: rank, mode, face index, area, normal,
and angle to -Z. Use it to decide which face to pass to stl-align
(e.g. via --normal X,Y,Z).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import trimesh

from ._stl_io import load_mesh


# Each mode gets its own palette of visually distinct hues. Rank 0 is the
# first color; rank N picks color N (or wraps if N >= len(palette)).
# Palettes are tuned so neighboring ranks are easy to tell apart and so
# the two modes don't share any colors.
MODE_PALETTES = {
    # Warm hues for hull facets.
    "hull-largest": [
        (220,  30,  30),   # 0: red
        (255, 140,   0),   # 1: orange
        (240, 220,   0),   # 2: yellow
        (190,  40, 180),   # 3: magenta
        (140,  60,  20),   # 4: brown
        (255, 100, 100),   # 5: light red (only used if --top > 5)
        (255, 200,  80),   # 6:
        (220, 160, 220),   # 7:
    ],
    # Cool hues for mesh facets — no overlap with the warm palette.
    "mesh-largest": [
        ( 30,  90, 220),   # 0: blue
        ( 30, 200, 200),   # 1: cyan
        ( 30, 200,  80),   # 2: green
        (120, 220, 120),   # 3: lime
        ( 80,  40, 200),   # 4: indigo
        ( 60, 150, 255),   # 5: sky
        ( 30, 160, 130),   # 6:
        (140, 200, 220),   # 7:
    ],
    # Distinct palette for hull-perpendicular mode. Greens/teals so it
    # doesn't clash with the warm hull-largest palette.
    "hull-perpendicular": [
        ( 30, 200,  80),   # 0: green
        ( 30, 200, 200),   # 1: cyan
        (120, 220, 120),   # 2: lime
        ( 30, 160, 130),   # 3: teal
        ( 60, 150, 255),   # 4: sky
        ( 80,  40, 200),   # 5: indigo
        (140, 200, 220),   # 6: pale-blue
        ( 30,  90, 220),   # 7: blue
    ],
}


def rank_color(mode: str, rank: int) -> tuple[int, int, int, int]:
    palette = MODE_PALETTES[mode]
    r, g, b = palette[rank % len(palette)]
    return (r, g, b, 255)


def hull_perpendicular_candidates(m: trimesh.Trimesh, ref_normal: np.ndarray, top: int):
    """Return top-N hull facets whose normals are most perpendicular to ref_normal.

    "Most perpendicular" = smallest |dot(facet_normal, ref_normal)|. The
    candidates are ranked by perpendicularity first; ties broken by area
    (larger first). Returns the same shape as hull_candidates.
    """
    hull = m.convex_hull
    if len(hull.facets) == 0:
        areas = hull.area_faces
        normals = hull.face_normals
        groups = [[i] for i in range(len(hull.faces))]
    else:
        areas = np.asarray(hull.facets_area)
        normals = np.asarray(hull.facets_normal)
        groups = list(hull.facets)

    ref = ref_normal / np.linalg.norm(ref_normal)
    abs_dot = np.abs(normals @ ref)
    # Sort by (perpendicularity ascending = abs_dot ascending), then area descending.
    # numpy lexsort: last key is primary. We want abs_dot ASC primary, areas DESC secondary.
    order = np.lexsort((-areas, abs_dot))[:top]
    out = []
    for rank, gi in enumerate(order):
        tri_centers = hull.triangles_center[groups[gi]]
        origin = tri_centers.mean(axis=0)
        out.append({
            "rank": rank,
            "area": float(areas[gi]),
            "normal": normals[gi].astype(float),
            "origin": origin.astype(float),
            "dot_ref": float(np.dot(normals[gi], ref)),
        })
    return out


def hull_candidates(m: trimesh.Trimesh, top: int):
    """Return list of (rank, normal, area, hull_facet_indices_in_hull).

    Each candidate is a hull facet — a coplanar group of hull triangles.
    Hull triangles correspond to a subset of the original mesh triangles
    via hull.metadata, but we can't trivially map hull faces back to
    source-mesh faces. So we color the equivalent triangles by finding
    mesh triangles whose centroid lies in the hull facet's plane.
    """
    hull = m.convex_hull
    if len(hull.facets) == 0:
        areas = hull.area_faces
        normals = hull.face_normals
        groups = [[i] for i in range(len(hull.faces))]
    else:
        areas = np.asarray(hull.facets_area)
        normals = np.asarray(hull.facets_normal)
        groups = list(hull.facets)

    order = np.argsort(-areas)[:top]
    out = []
    for rank, gi in enumerate(order):
        # Origin point on the hull plane: centroid of hull facet triangles.
        tri_centers = hull.triangles_center[groups[gi]]
        origin = tri_centers.mean(axis=0)
        out.append({
            "rank": rank,
            "area": float(areas[gi]),
            "normal": normals[gi].astype(float),
            "origin": origin.astype(float),
        })
    return out


def mesh_face_candidates(m: trimesh.Trimesh, top: int):
    """Return top-N coplanar mesh-facet groups (what plain --face largest sees)."""
    if len(m.facets) == 0:
        # Fallback: every triangle is its own "group".
        areas = m.area_faces
        order = np.argsort(-areas)[:top]
        return [{
            "rank": rank,
            "area": float(areas[i]),
            "normal": np.asarray(m.face_normals[i], dtype=float),
            "face_indices": np.array([i], dtype=np.int64),
        } for rank, i in enumerate(order)]

    areas = np.asarray(m.facets_area, dtype=float)
    order = np.argsort(-areas)[:top]
    return [{
        "rank": rank,
        "area": float(areas[i]),
        "normal": np.asarray(m.facets_normal[i], dtype=float),
        "face_indices": np.asarray(m.facets[i], dtype=np.int64),
    } for rank, i in enumerate(order)]


def color_faces_in_plane(
    m: trimesh.Trimesh,
    face_colors: np.ndarray,
    origin: np.ndarray,
    normal: np.ndarray,
    color: tuple[int, int, int, int],
    distance_tol: float,
    angle_tol_deg: float,
) -> int:
    """Color every mesh triangle whose centroid lies in (origin, normal) plane
    AND whose normal is within angle_tol_deg of `normal`. Returns count colored.
    """
    n = normal / (np.linalg.norm(normal) + 1e-12)
    centers = m.triangles_center
    # Signed distance from each centroid to the plane.
    d = np.abs((centers - origin) @ n)
    plane_mask = d <= distance_tol

    # Angle filter — face_normals dot plane normal close to +/- 1.
    fn = m.face_normals
    cos = fn @ n
    angle_mask = np.abs(cos) >= np.cos(np.radians(angle_tol_deg))

    mask = plane_mask & angle_mask
    face_colors[mask] = color
    return int(mask.sum())


def main() -> int:
    p = argparse.ArgumentParser(prog="stl-show-faces")
    p.add_argument("input", type=Path)
    p.add_argument(
        "output",
        type=Path,
        help="Output path. Suffix selects format: .ply (default, recommended for "
             "the slevesque 3D Viewer extension), .glb, or .obj.",
    )
    p.add_argument(
        "--mode",
        action="append",
        choices=sorted(MODE_PALETTES.keys()),
        help="Highlight mode. Pass multiple times to overlay (e.g. --mode hull-largest --mode mesh-largest). "
             "Use 'hull-perpendicular' (with --perpendicular-to) to find faces perpendicular to a reference normal.",
    )
    p.add_argument(
        "--perpendicular-to",
        type=str,
        metavar="X,Y,Z",
        default=None,
        help="Reference normal for --mode hull-perpendicular. Required for that mode.",
    )
    p.add_argument("--top", type=int, default=5, help="Top-N candidates per mode (default 5).")
    p.add_argument(
        "--plane-tol",
        type=float,
        default=0.5,
        help="Distance tolerance (mm) for mapping hull plane to mesh triangles (default 0.5).",
    )
    p.add_argument(
        "--angle-tol",
        type=float,
        default=5.0,
        help="Angle tolerance (deg) between mesh face normal and hull face normal (default 5).",
    )
    args = p.parse_args()

    modes = args.mode or ["hull-largest"]

    m = load_mesh(args.input)

    # Start with a light-gray base color for every face.
    face_colors = np.tile([200, 200, 200, 255], (len(m.faces), 1)).astype(np.uint8)

    print(f"{'mode':<19} {'rank':>4} {'color':<10} {'area':>10} {'colored_tris':>13}   "
          f"normal (x,y,z)              angle/dev")
    print("-" * 110)

    color_names = {
        (220,  30,  30): "red",        (255, 140,   0): "orange",
        (240, 220,   0): "yellow",     (190,  40, 180): "magenta",
        (140,  60,  20): "brown",      (255, 100, 100): "light-red",
        (255, 200,  80): "peach",      (220, 160, 220): "pink",
        ( 30,  90, 220): "blue",       ( 30, 200, 200): "cyan",
        ( 30, 200,  80): "green",      (120, 220, 120): "lime",
        ( 80,  40, 200): "indigo",     ( 60, 150, 255): "sky",
        ( 30, 160, 130): "teal",       (140, 200, 220): "pale-blue",
    }
    # Map mode -> palette key (some modes share palettes if needed).
    mode_palette = {
        "hull-largest": "hull-largest",
        "mesh-largest": "mesh-largest",
        "hull-perpendicular": "hull-perpendicular",
    }

    def name_of(color_rgba):
        return color_names.get(tuple(color_rgba[:3]), "?")

    for mode in modes:
        if mode == "hull-largest":
            cands = hull_candidates(m, args.top)
            for c in cands:
                color = rank_color(mode, c["rank"])
                n_painted = color_faces_in_plane(
                    m, face_colors, c["origin"], c["normal"], color,
                    distance_tol=args.plane_tol, angle_tol_deg=args.angle_tol,
                )
                ang = float(np.degrees(np.arccos(np.clip(np.dot(c["normal"], [0, 0, -1]), -1, 1))))
                nx, ny, nz = c["normal"]
                print(f"{mode:<19} {c['rank']:>4} {name_of(color):<10} {c['area']:>10.2f} {n_painted:>13}   "
                      f"({nx:+.3f},{ny:+.3f},{nz:+.3f})   {ang:>6.1f}")
        elif mode == "hull-perpendicular":
            if not args.perpendicular_to:
                print("error: --mode hull-perpendicular requires --perpendicular-to X,Y,Z",
                      file=sys.stderr)
                return 2
            ref = np.array([float(x) for x in args.perpendicular_to.split(",")])
            ref = ref / np.linalg.norm(ref)
            cands = hull_perpendicular_candidates(m, ref, args.top)
            for c in cands:
                color = rank_color(mode, c["rank"])
                n_painted = color_faces_in_plane(
                    m, face_colors, c["origin"], c["normal"], color,
                    distance_tol=args.plane_tol, angle_tol_deg=args.angle_tol,
                )
                # Angle to reference normal (90° = perfectly perpendicular).
                ang_to_ref = float(np.degrees(np.arccos(np.clip(abs(c["dot_ref"]), 0, 1))))
                ang_to_ref = 90.0 - ang_to_ref  # report deviation from 90°
                nx, ny, nz = c["normal"]
                print(f"{mode:<19} {c['rank']:>4} {name_of(color):<10} {c['area']:>10.2f} {n_painted:>13}   "
                      f"({nx:+.3f},{ny:+.3f},{nz:+.3f})   dev_from_90°={ang_to_ref:+.2f}")
        elif mode == "mesh-largest":
            cands = mesh_face_candidates(m, args.top)
            for c in cands:
                color = rank_color(mode, c["rank"])
                face_colors[c["face_indices"]] = color
                ang = float(np.degrees(np.arccos(np.clip(np.dot(c["normal"], [0, 0, -1]), -1, 1))))
                nx, ny, nz = c["normal"]
                print(f"{mode:<19} {c['rank']:>4} {name_of(color):<10} {c['area']:>10.4f} {len(c['face_indices']):>13}   "
                      f"({nx:+.3f},{ny:+.3f},{nz:+.3f})   {ang:>6.1f}")

    # Unweld so every face has its own 3 vertices, then write per-vertex
    # colors. PLY/GLB loaders in lightweight viewers (e.g. the slevesque
    # VSCode 3D Viewer's Three.js PLYLoader) often read only vertex colors,
    # not face colors — unwelding lets us encode face colors as vertex
    # colors without bleeding across shared edges.
    unwelded = trimesh.Trimesh(
        vertices=m.vertices[m.faces.reshape(-1)],
        faces=np.arange(len(m.faces) * 3).reshape(-1, 3),
        process=False,
    )
    vertex_colors = np.repeat(face_colors, 3, axis=0)
    unwelded.visual.vertex_colors = vertex_colors

    args.output.parent.mkdir(parents=True, exist_ok=True)
    suffix = args.output.suffix.lower().lstrip(".")
    if suffix not in {"ply", "glb", "obj"}:
        print(f"error: unsupported output suffix {args.output.suffix!r}; "
              f"use .ply, .glb, or .obj", file=sys.stderr)
        return 2
    unwelded.export(args.output, file_type=suffix)
    print(f"\nwrote {args.output}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
