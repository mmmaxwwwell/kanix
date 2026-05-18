# stl-pipeline

Parametric, declarative STL normalization for the raw 3D scans in the
repo's top-level `models/` folder. Each operation is a small Python
command (trimesh + numpy from nixpkgs — no pip). Per-object shell scripts
in `pipelines/` chain commands together and keep every intermediate stage
as its own STL so you can inspect them in a slicer.

**Scope:** only run this against `models/*.stl`. STLs under `stl/` are
rendered from `scad/` sources and are authoritative — do not normalize
them.

## Commands

Each is exposed both as a `nix run` app and as a shell command on `PATH`
inside the dev shell.

| Command       | Purpose                                                     |
|---------------|-------------------------------------------------------------|
| `stl-inspect` | Print bounds, extents, centroid, volume, watertightness     |
| `stl-align`   | Rotate so a chosen plane normal points to `-Z`              |
| `stl-scale`   | Scale by factor, longest-axis target, fit-box, or feature   |
| `stl-center`  | Translate so bounds-midpoint (or centroid) sits on origin   |
| `stl-drop`    | Pin min/max of an axis to a value (default: min Z = 0)      |

All transforming commands take `input.stl output.stl` plus flags, so they
compose by chaining intermediate files.

## Usage

### One-shot via `nix run`

```bash
nix run .#inspect -- scan.stl
nix run .#align   -- scan.stl out.stl --face largest --report
nix run .#scale   -- in.stl out.stl --longest 100
nix run .#center  -- in.stl out.stl --axes xy
nix run .#drop    -- in.stl out.stl --axis z --side min --value 0
```

### Dev shell (puts commands on `PATH`)

```bash
nix develop
stl-inspect scan.stl
stl-align scan.stl aligned.stl --face largest
```

### Per-object pipeline

Copy `pipelines/example-scan.sh` for each object, tune the parameters
at the top, and run it. Each stage writes a numbered STL into
`output/<name>/intermediate/` so you can open any stage in a slicer:

```bash
nix develop --command bash pipelines/example-scan.sh
# produces:
#   output/example/intermediate/01-aligned.stl
#   output/example/intermediate/02-scaled.stl
#   output/example/intermediate/03-centered.stl
#   output/example/intermediate/04-dropped.stl
#   output/example/example-normalized.stl
```

## Command reference

### `stl-align input output (--face {largest,lowest} | --normal X,Y,Z) [--to X,Y,Z] [--report]`

Rotates so a source normal points to a target direction (default `0,0,-1`
= the build plate). `--face largest` finds the biggest coplanar facet
group via trimesh; `--face lowest` picks the facet with the lowest
centroid Z; `--normal` rotates a known direction.

### `stl-scale input output (--factor N | --longest MM | --fit WxHxD | --feature MEASURED=ACTUAL) [--report]`

Uniform scaling only (non-uniform scaling would distort the geometry).
`--feature 41.2=38` divides measured-by-actual to derive the factor — use
it once you've measured a known feature in the scan.

### `stl-center input output [--axes {xy,xyz,x,y,z}] [--use {bounds,centroid}] [--report]`

Default centers XY using the bounding-box midpoint (symmetric). Use
`--use centroid` for mass-weighted centering.

### `stl-drop input output [--axis {x,y,z}] [--side {min,max}] [--value N] [--report]`

Generalized "drop to plate" — pins any axis bound to any value.

### `stl-inspect input`

Read-only; prints stats including the largest facet's area and normal,
which is what `stl-align --face largest` would pick.

## Adding a new operation

1. Drop `commands/<name>.py` in (use the existing files as a template;
   they all import from `_io.py`).
2. Add `<name> = mkCmd "<name>"` to the `commands` set in `flake.nix`.
3. Add a matching entry to `apps`.

The python env in `flake.nix` is shared across all commands — add
packages there once and every command can import them.
