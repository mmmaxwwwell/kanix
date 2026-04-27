# Kanix SCAD — Module & Preset Conventions

This directory holds the OpenSCAD models for Kanix belt-clip accessories. The
goal is to make every accessory bolt onto every Kanix clip *by construction* —
if you change the clip's plate size or hole grid, every accessory regenerates
to match without per-file edits.

## Architecture

```
scad/
├── lib/
│   ├── common.scad         shared constants (hole spacing, screw d, plate radii)
│   ├── presets.scad        belt presets — one bundle per supported clip size
│   ├── mounting-plate.scad the flat back plate (used by all accessories)
│   ├── kanix-plate.scad    the full hinged belt clip (separate concern)
│   ├── hinge.scad
│   └── hinge2.scad
├── kanix_plate_37x4mm.scad     render fixture for the 37x4 clip
├── kanix_plate_52x6.5mm.scad   render fixture for the 52x6.5 clip
├── mounting_plate_37x4.scad    render fixture for the 2x2 back plate
├── mounting_plate_52x65.scad   render fixture for the 3x3 back plate
└── <accessory>.scad            top-level accessory (e.g. wuben-g5-holster)
```

## Presets are the source of truth

A **preset** is a vector-of-pairs in `lib/presets.scad` that bundles every
dimension defining one belt-mounting interface:

```openscad
kanix_preset_52x65 = [
    ["plate_size",      52],
    ["plate_thickness",  5],
    ["belt_thickness", 6.5],
    ["hole_cols",        3],
    ["hole_rows",        3],
    ["hole_spacing",  kanix_hole_spacing],
    ["bolt_hole_d",    5.5],
    ["counterbore_d", 11.5],
    ["counterbore_depth", 2.4],
    ...
];
```

Read fields with `preset_get(preset, "plate_size")`. Misspell a key and you
get `undef`, which fails loudly the moment it hits a numeric op — that is
intentional, do not paper over it with default fallbacks.

### Currently supported presets

| Preset                | Plate    | Belt    | Hole grid |
|-----------------------|----------|---------|-----------|
| `kanix_preset_37x4`   | 37 × 4   | 4 mm    | 2 × 2     |
| `kanix_preset_52x65`  | 52 × 5   | 6.5 mm  | 3 × 3     |

## Module conventions

Every accessory module that mounts to a Kanix clip:

1. **Takes a preset as its first parameter.** Never hardcode `plate_size`,
   `hole_cols`, etc. — always derive from the preset. This is what makes
   "render for 2×2 and 3×3" a free property of the design.
2. **Uses `mounting_plate(preset)` for its back plate** instead of rolling
   its own. The plate is rounded-square + filleted top edge + counterbored
   M5 grid. If you need a thicker plate (e.g. for screw depth into the
   accessory body), pass `thickness=N`; the bolt grid still comes from the
   preset.
3. **Ships with one render fixture per preset.** A render fixture is a
   thin top-level `.scad` that does nothing but `include` the preset and
   call the module. Naming: `<accessory>_37x4.scad`, `<accessory>_52x65.scad`.
   This keeps `scripts/test-scad.sh` honest — every accessory is verified
   against every preset on every test run.

### Skeleton for a new accessory

```openscad
// lib/my-accessory.scad
include <common.scad>
include <presets.scad>
use <mounting-plate.scad>

module my_accessory(preset) {
    plate_t = preset_get(preset, "plate_thickness");
    // ... derive everything else from preset ...

    union() {
        mounting_plate(preset);
        // accessory-specific geometry, positioned relative to plate_t
    }
}
```

```openscad
// my_accessory_37x4.scad   (render fixture)
include <lib/presets.scad>
use <lib/my-accessory.scad>
$fn = 64;
my_accessory(kanix_preset_37x4);
```

```openscad
// my_accessory_52x65.scad   (render fixture)
include <lib/presets.scad>
use <lib/my-accessory.scad>
$fn = 64;
my_accessory(kanix_preset_52x65);
```

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
`scad/*.scad` to STL and fails on compile errors or empty output. Library
files in `scad/lib/` are not rendered standalone.

### Don't render to inspect geometry — let the user preview

The user has the OpenSCAD GUI open and sees changes instantly. **Do not
render STLs on the agent side to "check the result" of a SCAD edit.** That's
wasted time and tokens — the user will look at the model.

A quick render is acceptable purely as a syntax/compile check after a
non-trivial edit (then discard the output):

```bash
openscad -o /tmp/check.stl scad/<accessory>_<preset>.scad
```

That's for catching parse errors, not for inspecting shape. Stop after it
succeeds and let the user preview.

**Never** run `bash scripts/test-scad.sh` mid-iteration — it re-renders every
fixture at every preset and is slow. Run it only (a) as a final pre-commit
check, or (b) when a `lib/*.scad` change could affect other accessories that
share that library.

When adding a new accessory or preset:
1. Add the preset (if new) to `lib/presets.scad`.
2. Add a render fixture per preset at `scad/<accessory>_<preset>.scad`.
3. Run `bash scripts/test-scad.sh` and confirm both fixtures pass.
