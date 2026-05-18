# Kanix SCAD — Module & Preset Conventions

This directory holds the OpenSCAD models for Kanix belt-clip accessories. The
goal is to make every accessory bolt onto every Kanix clip *by construction* —
if you change the clip's bolt grid or belt thickness, every accessory
regenerates to match without per-file edits.

## Architecture

```
scad/
├── lib/
│   ├── common.scad         shared constants (hole spacing, screw d, plate radii)
│   ├── presets.scad        grid + belt presets (source of truth)
│   ├── mounting-plate.scad accessory back plate (consumes grid preset)
│   ├── kanix-plate.scad    the full hinged belt clip (consumes grid + belt)
│   ├── hinge.scad / hinge2.scad
│   ├── belt-clip.scad / carabiner-clip.scad / clicker-holder.scad / ...
│   └── <accessory>.scad    accessory modules
├── plates/
│   └── kanix_plate_<grid>_<belt>.scad   render fixtures for the clip (one per
│                                        grid × belt combination)
└── <accessory>_<grid>.scad render fixtures for accessories (one per grid)
```

## The two preset families

Presets live in [lib/presets.scad](lib/presets.scad). There are two families
because clips and accessories need different things:

### `kanix_grid_<cols>x<rows>` — bolt pattern + plate footprint

What every **accessory** sees. Fields: `hole_cols`, `hole_rows`, `hole_spacing`,
`plate_w`, `plate_h`, `pilot_hole_d`. Rows imply belt height — 2 rows means
1.5" / 38mm belt, 3 rows means 2" / 52mm belt.

Available grids:

| Grid              | Cols × Rows | Plate (W × H mm) | Belt height |
|-------------------|-------------|------------------|-------------|
| `kanix_grid_2x2`  | 2 × 2       | 33.05 × 38       | 38 (1.5")   |
| `kanix_grid_3x2`  | 3 × 2       | 52.10 × 38       | 38 (1.5")   |
| `kanix_grid_4x2`  | 4 × 2       | 71.15 × 38       | 38 (1.5")   |
| `kanix_grid_2x3`  | 2 × 3       | 33.05 × 52       | 52 (2")     |
| `kanix_grid_3x3`  | 3 × 3       | 52.10 × 52       | 52 (2")     |
| `kanix_grid_4x3`  | 4 × 3       | 71.15 × 52       | 52 (2")     |

### `kanix_belt_<h>x<t>` — belt-only fields (clip)

What only the **clip** sees. Fields: `belt_height`, `belt_thickness`,
`plate_thickness`, `screw_length`. Accessories never touch this.

Available belts:

| Belt                  | Belt H | Belt thickness | Plate t | Use with        |
|-----------------------|--------|----------------|---------|-----------------|
| `kanix_belt_38x5_3`   | 38     | 5.3            | 5       | 2-row grids     |
| `kanix_belt_52x6_5`   | 52     | 6.5            | 5       | 3-row grids     |
| `kanix_belt_52x12`    | 52     | 12             | 5       | 3-row grids     |

### Plate matrix — which combinations exist

A plate fixture exists at `scad/plates/` for every valid grid × belt pair.
2-row grids pair with 38mm belts only; 3-row grids pair with 52mm belts only.

**38mm belt (1.5" duty) — 2-row grids:**

| Grid \ Belt | `38x5.3` (5.3mm) |
|-------------|------------------|
| `2x2`       | `kanix_plate_2x2_38x5.3.scad` |
| `3x2`       | `kanix_plate_3x2_38x5.3.scad` |
| `4x2`       | `kanix_plate_4x2_38x5.3.scad` |

**52mm belt (2" duty) — 3-row grids:**

| Grid \ Belt | `52x6.5` (6.5mm) | `52x12` (12mm) |
|-------------|------------------|----------------|
| `2x3`       | `kanix_plate_2x3_52x6.5.scad` | `kanix_plate_2x3_52x12.scad` |
| `3x3`       | `kanix_plate_3x3_52x6.5.scad` | `kanix_plate_3x3_52x12.scad` |
| `4x3`       | `kanix_plate_4x3_52x6.5.scad` | `kanix_plate_4x3_52x12.scad` |

Total: **9 plate fixtures**, all rendering full clips.

### How to read a preset

```openscad
spacing = preset_get(grid, "hole_spacing");  // → 19.05
cols    = preset_get(grid, "hole_cols");     // → 3
```

Misspell a key → `undef` → loud failure on first numeric op. **Do not paper
over with default fallbacks** — that's the point.

## Naming convention

Filenames encode the dependency:

- **Plates** depend on both grid and belt thickness: `kanix_plate_<grid>_<beltHxT>.scad`
  - Examples: `kanix_plate_3x3_52x6.5.scad`, `kanix_plate_2x2_38x4.scad`
- **Accessories** only depend on grid (they bolt onto the plate from outside,
  belt thickness is invisible to them): `<accessory>_<grid>.scad`
  - Examples: `clicker_holder_3x3.scad`, `wuben_c3_holster_2x2.scad`

`<grid>` is always `<cols>x<rows>` (width × height). `<beltHxT>` uses a literal
decimal point for thickness (e.g. `38x5.3`, not `38x53` or `38x5_3`).

Variable names can't contain dots in OpenSCAD, so the preset variable uses
underscore: `kanix_belt_38x5_3`. The filename uses the dot: `kanix_plate_2x2_38x5.3.scad`.

## Module conventions

Every accessory module that mounts to a Kanix clip:

1. **Takes a grid preset as its first parameter.** Never hardcode `plate_size`,
   `hole_cols`, etc. — always derive from the preset. This is what makes
   "render for every grid" a free property of the design.
2. **Uses `mounting_plate(grid)` for its back plate.** The plate is a rounded
   rectangle sized to the grid's `plate_w × plate_h` with the grid's bolt
   pattern drilled blind from below. If you need a thicker plate for screw
   depth into the accessory body, pass `thickness=N`.
3. **Ships with one render fixture per applicable grid.** A render fixture is
   a thin `.scad` at `scad/` that includes the preset and calls the module.

### Skeleton for a new accessory

```openscad
// lib/my-accessory.scad
include <common.scad>
include <presets.scad>
use <mounting-plate.scad>

module my_accessory(grid) {
    plate_w = preset_get(grid, "plate_w");
    plate_h = preset_get(grid, "plate_h");
    // ... derive everything else from grid ...

    union() {
        mounting_plate(grid);
        // accessory geometry, positioned relative to plate_w/h
    }
}
```

```openscad
// my_accessory_3x2.scad   (one render fixture per grid)
include <lib/presets.scad>
use <lib/my-accessory.scad>
$fn = 64;
my_accessory(kanix_grid_3x2);
```

## Clip plates

Clip plates (`scad/plates/kanix_plate_*.scad`) call the wrapper
`kanix_plate_from_presets(grid, belt)`. This is a thin shim over the original
positional `kanix_plate(...)` module.

**Current limitation:** `kanix_plate` only supports **square** plates (2x2,
3x3). The 6 non-square fixtures render only a placeholder back plate until
`kanix_plate` is rewritten — see "Planned migrations" below.

## Coordinate convention

In `kanix_plate`'s local frame: **+Y is "up the belt"** (the hinge runs along
the top edge at `+plate_h/2`), **+X is "across the belt"** (the locking tabs
sit at `±plate_w/2`), **+Z is "away from the body"** (the bolt heads come up
from `Z=0`).

So `plate_w` is the X dimension (across the belt, scales with `hole_cols`)
and `plate_h` is the Y dimension (up the belt, matches `belt_height`).

## Planned migrations

Two operations remain. Both are checked in here so progress is resumable
across sessions — update the status as you go.

### Op 1: Rectangularize `kanix_plate` — **not started**

Goal: drop the square-only restriction so the 6 stubbed plate fixtures render
real clips.

Rules for the agent:

- Replace the positional `plate_size=` parameter in `kanix_plate(...)` with
  `plate_w=` and `plate_h=` throughout `lib/kanix-plate.scad`. Anywhere the
  code does `plate_size/2` on an X-axis feature → `plate_w/2`. On a Y-axis
  feature → `plate_h/2`.
- Hinge length, locking-tab width, and the bottom-edge latch all run along
  the X axis → they scale with `plate_w`.
- The top-edge belt fillet and bottom-block depth run along Y → they scale
  with `plate_h`.
- Delete the `assert(plate_w == plate_h, …)` line in
  `kanix_plate_from_presets`. That assert is the explicit blocker.
- Do **not** touch the legacy `kanix_preset_*` aliases. They still carry
  `plate_size` (square-only) and will be deleted in Op 2 anyway.
- After the rewrite, edit the 6 stubbed fixtures in `scad/plates/` (the ones
  marked ⚠ in the plate matrix): replace `mounting_plate(grid, thickness=…)`
  with `kanix_plate_from_presets(grid, belt)` and remove the TODO comment.
  Flip the ⚠ to ✓ in the matrix tables above.
- Syntax-check one square + one rectangular fixture as the final step
  (`openscad -o /tmp/check.stl scad/plates/kanix_plate_4x3_52x6.5.scad`).

### Op 2: Migrate accessories off the legacy presets — **not started**

Goal: every accessory takes a `kanix_grid_*` (not a `kanix_preset_*`), then
delete the legacy aliases from `lib/presets.scad`.

Find work to do: `grep -l kanix_preset_ scad/*.scad scad/lib/*.scad`.

**The accessory-side rule:** accessories see the bolt grid and nothing else.
If an accessory module reads `belt_thickness`, `belt_height`, `plate_thickness`,
or `screw_length`, that's a bug — flag it to the user instead of silently
porting it.

Preset rename map (legacy → new):

| Legacy preset           | New grid preset    |
|-------------------------|--------------------|
| `kanix_preset_38x4`     | `kanix_grid_2x2`   |
| `kanix_preset_52x65`    | `kanix_grid_3x3`   |

Fixture rename map (file rename, not just edit — use `git mv`):

| Legacy suffix | New suffix |
|---------------|------------|
| `_38x4.scad`  | `_2x2.scad` |
| `_52x65.scad` | `_3x3.scad` |

Single-variant accessories (only one grid today): rename to the canonical
grid suffix, then stub fixtures for every other grid the accessory should
plausibly support with a `TODO` comment matching the plate-stub style.

When `grep -l kanix_preset_ scad/` returns empty: delete the
`kanix_preset_38x4` and `kanix_preset_52x65` blocks from
[lib/presets.scad](lib/presets.scad), and delete the "Legacy presets"
backward-compat section.

Track per-accessory progress here as you go:

| Accessory               | Status           | Notes |
|-------------------------|------------------|-------|
| `clicker_holder`        | not started      | has `_38x4` and `_52x65` today |
| `wuben-c3-holster`      | not started      | has unsuffixed + `-2x2` variant |
| `carabiner_clip`        | not started      | `1x2`/`1x3` partial-row fixtures — keep partial-plate semantics |
| `belt_clip`             | not started      | has `2x2`/`3x2`/`3x3` `_38mm` fixtures |
| (any others)            | not started      | run the grep to find them |

## Why not classes?

OpenSCAD has no classes, no methods, no inheritance, no mutation. The
preset-as-vector-of-pairs + module-takes-preset pattern is the closest
idiomatic equivalent and the ceiling of what's worth building. Don't try
to simulate inheritance via preset-merging functions — every BOSL2-style
library converges on this same pattern and stops there for good reason.

## `include` vs `use`

- **`include <file>`** — pulls everything in, including top-level statements
  and constants. Use this for `common.scad` and `presets.scad` (you want
  the constants).
- **`use <file>`** — imports modules and functions only, ignores top-level
  geometry. Use this for files that define modules (`mounting-plate.scad`,
  `kanix-plate.scad`).

If you `include` a module file, any top-level render at the bottom of that
file will also render — that's why the library files are `use`d.

## Testing

`bash scripts/test-scad.sh` from the repo root renders every top-level
`scad/*.scad` and `scad/plates/*.scad` to STL and fails on compile errors or
empty output. Library files in `scad/lib/` are not rendered standalone.

### Don't render to inspect geometry — let the user preview

The user has the OpenSCAD GUI open and sees changes instantly. **Do not
render STLs on the agent side to "check the result" of a SCAD edit.** That's
wasted time and tokens — the user will look at the model.

A quick render is acceptable purely as a syntax/compile check after a
non-trivial edit (then discard the output):

```bash
openscad -o /tmp/check.stl scad/plates/kanix_plate_2x2_38x4.scad
```

That's for catching parse errors, not for inspecting shape. Stop after it
succeeds and let the user preview.

**Never** run `bash scripts/test-scad.sh` mid-iteration — it re-renders every
fixture at every preset and is slow. Run it only (a) as a final pre-commit
check, or (b) when a `lib/*.scad` change could affect other accessories that
share that library.

When adding a new accessory or preset:
1. Add the grid (if new) to `lib/presets.scad`.
2. Add a render fixture per grid at `scad/<accessory>_<grid>.scad`.
3. Run `bash scripts/test-scad.sh` and confirm all fixtures pass.

When adding a new clip plate:
1. Add the belt preset (if new) to `lib/presets.scad`.
2. Add a render fixture at `scad/plates/kanix_plate_<grid>_<belt>.scad`.
3. Run `bash scripts/test-scad.sh`.
