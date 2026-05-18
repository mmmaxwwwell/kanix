# stl-pipeline — Claude Code instructions

A self-contained Nix flake for normalizing 3D-scanned STLs. Operations are
small parametric Python commands (`trimesh` + `numpy` from nixpkgs — no
pip). Per-object shell scripts in `pipelines/` chain commands together
and keep every intermediate stage as its own STL.

## Scope: `models/` only

**This pipeline only operates on STLs in the repo's top-level `models/`
folder** (e.g. `models/280x.stl`, `models/300.stl`). Those are the raw
3D-scan inputs that need normalization.

Do **not** run this pipeline against:

- `stl/` — these are STLs rendered from `scad/` sources. They're already
  normalized by construction (OpenSCAD coordinates are authoritative).
  Re-normalizing them would silently diverge from the SCAD source of truth.
- `site/public/models/` — published artifacts; treat as read-only outputs.
- Any other STL in the repo.

Per-object pipeline scripts in `pipelines/` should set `SRC` to a path
under `models/` and `OUT_DIR` to a path under `models/normalized/` (or
similar) so raw scans and normalized outputs stay distinguishable.

## Layout

```
stl-pipeline/
├── flake.nix          # exposes one nix-run app per command, plus a dev shell
├── commands/          # Python package — one module per operation
│   ├── __init__.py
│   ├── _stl_io.py     # shared load/save/report helpers
│   ├── inspect.py     # stats only
│   ├── align.py       # rotate plane normal to -Z (or any target)
│   ├── scale.py       # factor / longest / fit / feature
│   ├── center.py      # bounds-mid or centroid on chosen axes
│   ├── drop.py        # pin an axis bound to a value
│   └── show_faces.py  # write colored .ply highlighting candidate planes
├── pipelines/         # per-object shell scripts that chain commands
│   └── example-scan.sh
└── README.md
```

## Running commands

Each command is exposed as a `nix run` app **and** as a shell command on
`PATH` inside the dev shell. Both forms accept the same flags.

### One-shot via `nix run`

```bash
nix run /home/max/git/kanix/stl-pipeline#inspect -- scan.stl
nix run /home/max/git/kanix/stl-pipeline#align   -- in.stl out.stl --face largest --report
nix run /home/max/git/kanix/stl-pipeline#scale   -- in.stl out.stl --longest 100
nix run /home/max/git/kanix/stl-pipeline#center  -- in.stl out.stl --axes xy
nix run /home/max/git/kanix/stl-pipeline#drop    -- in.stl out.stl --axis z --side min --value 0
```

Always pass `--` between the app name and script flags, otherwise `nix
run` swallows them.

### Inside the dev shell

```bash
nix develop /home/max/git/kanix/stl-pipeline
stl-inspect scan.stl
stl-align scan.stl aligned.stl --face largest
```

### Running a per-object pipeline

```bash
nix develop /home/max/git/kanix/stl-pipeline --command bash pipelines/<object>.sh
```

This is how the per-object scripts in `pipelines/` are designed to be
invoked — they assume the `stl-*` commands are on `PATH`.

## Commands reference

| Command          | Required | Key flags                                                                              |
|------------------|----------|----------------------------------------------------------------------------------------|
| `stl-inspect`     | `input`  | (no flags)                                                                             |
| `stl-align`       | `in out` | `--face {largest,lowest,hull-largest}` **or** `--normal X,Y,Z`; optional `--to X,Y,Z` (default `0,0,-1`), `--prefer-hull`, `--report` |
| `stl-align-frame` | `in out` | `--primary X,Y,Z --primary-to X,Y,Z --secondary X,Y,Z --secondary-to X,Y,Z`. Rotates so two non-parallel source directions land on two targets simultaneously (primary exact, secondary projected). Use when a single normal leaves yaw ambiguous. |
| `stl-rotate`      | `in out` | `--axis X,Y,Z --degrees N`. Plain axis-angle rotation around origin (right-hand rule). Use for residual yaw/pitch/roll tweaks after `stl-align-frame`. |
| `stl-scale`       | `in out` | one of `--factor N` / `--longest MM` / `--fit WxHxD` / `--feature MEASURED=ACTUAL`     |
| `stl-center`      | `in out` | `--axes {xy,xyz,x,y,z}` (default `xy`), `--use {bounds,centroid}` (default `bounds`)   |
| `stl-drop`        | `in out` | `--axis {x,y,z}` (default `z`), `--side {min,max}` (default `min`), `--value N` (default `0`) |
| `stl-show-faces`  | `in out` | `--mode {hull-largest,mesh-largest,hull-perpendicular}` (repeatable), `--top N`, `--perpendicular-to X,Y,Z` (required for hull-perpendicular); output suffix picks format (`.ply` recommended) |

**`stl-align --face` modes:**

- `largest` — biggest **mesh** coplanar facet group. Best when the scan is clean (well-segmented facets).
- `lowest` — facet with lowest centroid Z. Use when the scan already sits roughly flat.
- `hull-largest` — biggest **convex-hull** facet. **Best for noisy 3D scans**: the hull aggregates noisy triangles into large clean planes, so this finds the actual broad faces even when `m.facets` under-segments.
- `--prefer-hull` (with `--face largest`): restricts to mesh facets that lie on the hull. Harmful on noisy scans (shrinks candidates to slivers); useful on clean meshes.

**`stl-align --normal X,Y,Z`**: pass the picked normal explicitly (e.g. after using `stl-show-faces` to identify the right plane). Note: if a component is negative, use `=`-syntax to avoid argparse treating the value as a flag: `--normal=-0.18,-0.23,0.96`.

Every transforming command supports `--report` to print before/after
bounds and extents to stderr.

### Recommended operation order

When chaining commands in a per-object pipeline, the safe order is:

1. **align** — rotate before anything else so the axes mean what you expect.
2. **scale** — distances become final mm so later steps can use absolute values.
3. **center** — bounds-midpoint translation; depends on final scale.
4. **drop** — pin min Z to 0 last; overrides any Z component centering applied.

Deviating from this order is fine when you know what you're doing, but
default to it for new pipelines.

## Previewing meshes interactively (f3d)

The dev shell ships `f3d`, a fast viewer that supports PLY per-vertex
colors and hot-reload (press `U` in the window to re-read the file from
disk after a script regenerates it). Use it to inspect intermediate
stages of a pipeline and — critically — to **drive the interactive
orientation workflow below** with the user.

**Launching the viewer** (always wrap in `bash -c` so the dev shell PATH
is set up before `f3d` resolves):

```bash
nix develop --command bash -c \
  'f3d ../models/normalized/<obj>/<file>.ply \
    --scalar-coloring --coloring-array=RGBA --coloring-component=-2 \
    --axis --grid --up +Z'
```

**Critical viewer gotchas:**

- **Always pass `--up +Z`.** f3d's default is `+Y` up, but every mesh
  in this pipeline (and 3D printing in general) uses `+Z` up. Without
  `--up +Z`, the part renders rotated 90° and "the back face is on
  top" when in fact the data is correct — the camera is just looking
  at it sideways. Many wasted iterations have started here.
- **Use `nohup … & disown`, not just `&`.** Piping a foreground f3d
  through `| head -N` or invoking via `nix develop --command f3d <args>`
  directly causes SIGPIPE (exit 144) before the window opens. The
  reliable pattern from an agent's Bash tool:

  ```bash
  F3D=$(realpath "$(command -v f3d 2>/dev/null)" 2>/dev/null \
        || echo /nix/store/<hash>-f3d-3.5.0/bin/f3d)
  nohup $F3D <file>.ply --scalar-coloring --coloring-array=RGBA \
    --coloring-component=-2 --axis --grid --up +Z \
    >/tmp/f3d.log 2>&1 &
  disown
  ```

  Or inside a dev shell: wrap in `bash -c '…'` so the shell's PATH is
  active before f3d is looked up.

Run it from `stl-pipeline/` with relative `../models/...` paths — never
hard-code `/home/max/...`. Launch it as a **background** tool call so it
doesn't block the agent loop; the user interacts with the window
directly.

Key bindings inside f3d: drag = orbit, scroll = zoom, right-drag = pan,
`U` = reload from disk, `R` = reset camera, `S` = toggle scalar
coloring, `Q` = quit.

## Interactive orientation workflow

3D scans of a real-world object almost never come out the right way up.
Picking the correct "base plane" or "up direction" is judgment — the
agent shouldn't guess. Use this loop:

1. **Inspect.** Run `stl-inspect` and report bounds, extents, and the
   largest facet's normal. This grounds the conversation in numbers.
2. **Generate a color-highlighted preview.** Run `stl-show-faces` and
   tell the user *exactly what each color means*. Each rank within a
   mode gets a **distinct hue**, not a fade — neighboring ranks must
   be easy to tell apart at a glance.

   - `hull-largest` palette (warm): rank 0 **red**, 1 **orange**,
     2 **yellow**, 3 **magenta**, 4 **brown**, 5 **light-red**,
     6 **peach**, 7 **pink**.
   - `mesh-largest` palette (cool, no overlap with warm): rank 0
     **blue**, 1 **cyan**, 2 **green**, 3 **lime**, 4 **indigo**,
     5 **sky**, 6 **teal**, 7 **pale-blue**.
   - Everything else stays light gray.

   The `stl-show-faces` legend prints the color name next to each rank;
   echo that legend to the user verbatim so they can match what they
   see to what you're proposing. Example:

   > Top-3 hull facets highlighted:
   > - **red** = rank 0, 1355 mm² (normal (-0.18, -0.23, +0.96))
   > - **orange** = rank 1, 632 mm²
   > - **yellow** = rank 2, 417 mm²
   >
   > Open the preview when you're ready and tell me what surface red lands on.

   **Do not open f3d yet.** Wait for the user to say "go" / "show me" /
   "open it" / "start". This avoids spawning windows the user wasn't
   ready for and lets them set up their own viewport first.
3. **Open the viewer on request.** When the user signals readiness,
   launch f3d in the background (see "Previewing meshes" above) and ask
   a single concrete question that maps the colors back to physical
   meaning. Examples:

   > Looking at the red region in f3d: is that the back, front, bottom,
   > or a side of the device?

   > Which way do the antennas point in the current axes — +X, +Y, +Z,
   > or some combination?
4. **Apply the user's answer with explicit transforms.** If the user
   says "red is the back, antennas point in +X," translate that into
   concrete `stl-align` / rotate steps. Show the input/output bounds via
   `--report` so the user can sanity-check.
5. **Re-preview.** Regenerate the colored PLY at the new orientation
   and ask the user to press `U` in the open f3d window (or to say "go"
   again if they closed it). Iterate until the orientation is right.

**Rules for the agent:**

- One highlight color per *highlight type*, not per face. Within a type,
  use the rank-0 → rank-N fade so the user can rank-order at a glance.
- Always state what each color means before showing the preview.
- Always wait for an explicit "go" / "show me" / "open" / "start"
  before launching the viewer.
- Always use **relative paths from `stl-pipeline/`** in commands you
  show the user, never `/home/...` absolute paths.
- When passing normals with negative components to `stl-align`, use
  `--normal=-x,-y,-z` (equals sign) — argparse parses the value as a
  flag otherwise.
- Outputs for a holster/reference workflow (modeling *around* the
  scan) should land in `../models/normalized/<obj>/<purpose>/` with
  the orientation reflecting the **use case**, not printability. E.g.
  for a holster, orient with Z up matching how the device is held —
  do *not* drop a face to the build plate.

## Adding a new operation

1. Add `commands/<name>.py`. Use any existing file as a template — they
   all follow the same shape: `argparse`, load via `_stl_io.load_mesh`,
   apply a trimesh transform, save via `_stl_io.save_mesh`. Imports are
   relative (`from ._stl_io import ...`).
2. Register it in `flake.nix`:
   - Add `<name> = mkCmd "<name>";` to the `commands` attrset.
   - Add a matching entry under `apps`.
3. The shared Python env is the `pythonEnv` binding at the top of the
   flake — add packages there once and every command can import them.

`mkCmd` builds a `stl-<name>` shell wrapper that puts the package on
`PYTHONPATH` and invokes `python -m commands.<name>`. **Do not** rename
command files to anything that shadows a stdlib module (`inspect.py`,
`stat.py`, `io.py`, etc. — that's why the package is run via `-m`
instead of by path).

## Adding a new per-object pipeline

1. Copy `pipelines/example-scan.sh` to `pipelines/<object>.sh`.
2. Tune the variables at the top (`SRC`, `OUT_DIR`, `ALIGN_FACE`,
   `SCALE_LONGEST_MM`, `CENTER_AXES`).
3. Keep the numbered intermediate files (`01-aligned.stl`,
   `02-scaled.stl`, …) — they're how you debug the pipeline in a slicer
   if the final output looks wrong.

The pipeline scripts are intentionally **per-object**, not parameterized
mega-scripts. Each scan has its own tuning, and a dedicated script
captures those decisions in a place that version-controls cleanly.

## Gotchas

### Pipeline mechanics

- **Flake evaluation needs git tracking.** New files under `stl-pipeline/`
  must be at least `git add -N`'d in the parent `kanix` repo, or Nix will
  silently skip them when copying into the store. Symptoms: `ImportError`
  for a module that obviously exists, or a script that runs an older
  version of itself.
- **No non-uniform scaling.** `stl-scale` only does uniform scaling — that's
  intentional. Non-uniform scaling distorts geometry and is almost never
  what you want for a scanned part. If you genuinely need it, add a new
  command (e.g. `stl-stretch`) rather than overloading `scale`.
- **No watertight repair, no decimation, no smoothing.** This pipeline
  only does rigid transforms + uniform scale. Mesh repair belongs in a
  separate tool (Blender, MeshLab, `trimesh.repair`) and should run
  *before* this pipeline if needed.

### Face picking on noisy scans

- **`m.facets` under-segments wildly on noisy scans.** Plain
  `stl-align --face largest` will pick a single ~1.4 mm² triangle group
  on a scan where the actual flat region is 1300+ mm². Default to
  `--face hull-largest` for any 3D scan; reserve plain `largest` for
  clean CAD-source meshes.
- **`--prefer-hull` is *harmful* on noisy scans.** It restricts the
  candidate pool to mesh facets that also lie on the hull, leaving only
  tiny slivers on noisy meshes. Use `--face hull-largest` instead.
- **`stl-align --face largest` picks coplanar facet groups**, not single
  triangles. For meshes with no detected coplanar groups it falls back
  to single-triangle search, which is rarely useful.
- **A single normal under-constrains orientation** — pitch+roll are
  fixed, yaw is free. For reference-mesh workflows (modeling a holster
  around a scan) use `stl-align-frame` with TWO faces (e.g. back→-Z
  AND bottom→-Y). Identify the second face via `stl-show-faces --mode
  hull-perpendicular --perpendicular-to <primary-normal>`.
- **The rank-0 hull facet ≠ every -Z-leaning triangle.** When
  highlighting "the back face" for the user, mask to triangles whose
  centroid lies in the rank-0 plane AND whose normal agrees, not just
  `face_normals[:, 2] < -0.95`. The looser threshold catches curved
  shoulders and ruins edge-band sampling.

### Yaw refinement

- **PCA on the back face's vertices is 90° ambiguous.** The largest
  eigenvector picks whichever side is longer — could be antenna-axis or
  device-width axis. Ask the user "long axis along X or Y?" before
  applying a PCA-derived yaw; don't infer it.
- **`stl-rotate` rotates around the origin**, not the mesh centroid.
  Iterative residual-fitting converges but slowly because each rotation
  also translates the part XY-wise. To bake a final yaw, iterate the
  script-update loop: run pipeline → measure residual → patch YAW_DEG
  → repeat. Converges in ~5–8 iterations.
- **Apply drop *after* yaw, not before.** Drop is a Z-only translation;
  it commutes with Z-axis rotation mathematically, but visually a yaw
  applied after a drop translates the part across the grid in f3d,
  which is disorienting.

### Argparse / shell

- **`stl-align` negative normals need `=` syntax.** Pass
  `--normal=-0.18,-0.23,0.96` (equals sign). With a space, argparse
  parses `-0.18,...` as a separate flag and errors out.

## When to use this vs. OpenSCAD

OpenSCAD's `import()` + `translate()`/`scale()` can also normalize an
STL declaratively, and the `scad/` folder already uses OpenSCAD. Use
**this pipeline** when:

- You need plane alignment (OpenSCAD can't detect planar features).
- You want feature-based scaling (`--feature 41.2=38`).
- You want named, slicer-inspectable intermediate stages.

Use **an OpenSCAD wrapper** when the transform is a fixed rotation +
uniform scale you already know the numbers for, and you want it to live
alongside the rest of the parametric model in `scad/`.
