"""Shared I/O helpers for STL pipeline commands."""
from __future__ import annotations

import sys
from pathlib import Path

import trimesh


def load_mesh(path: Path) -> trimesh.Trimesh:
    mesh = trimesh.load(path, force="mesh")
    if not isinstance(mesh, trimesh.Trimesh):
        print(f"error: {path} did not load as a single mesh", file=sys.stderr)
        sys.exit(1)
    return mesh


def save_mesh(mesh: trimesh.Trimesh, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    mesh.export(path)


def report(label: str, mesh: trimesh.Trimesh) -> None:
    b = mesh.bounds
    e = mesh.extents
    print(
        f"[{label}] bounds=({b[0,0]:.3f},{b[0,1]:.3f},{b[0,2]:.3f}) "
        f"-> ({b[1,0]:.3f},{b[1,1]:.3f},{b[1,2]:.3f})  "
        f"extents=({e[0]:.3f},{e[1]:.3f},{e[2]:.3f})",
        file=sys.stderr,
    )
