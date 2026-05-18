// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Kanix Presets — grids and belts
//
// Two preset families:
//
//   kanix_grid_<cols>x<rows>   — bolt pattern + plate footprint. Everything an
//                                accessory needs to bolt onto a Kanix plate.
//                                Rows imply belt height: 2 rows = 38mm/1.5"
//                                belt, 3 rows = 52mm/2" belt.
//
//   kanix_belt_<h>x<t>         — belt-only fields (height, thickness, plate
//                                thickness, screw length). Consumed by the
//                                kanix_plate clip module. Accessories ignore.
//
// A render fixture for the clip combines the two:
//   kanix_plate(kanix_grid_3x2, kanix_belt_38x4);
//
// A render fixture for an accessory only needs the grid:
//   clicker_holder(kanix_grid_3x2);
//
// Look up fields with preset_get(p, "key"). Misspell a key → undef → loud
// failure on first numeric op. Do not paper over with default fallbacks.

include <common.scad>

// ============================================================================
// GRID PRESETS — bolt pattern + plate footprint (what accessories see)
// ============================================================================
//
// Field reference:
//   name          short id for fixtures
//   hole_cols     bolt columns (across the belt)
//   hole_rows     bolt rows   (up the belt) — 2 = 38mm belt, 3 = 52mm belt
//   hole_spacing  mm between adjacent holes (always kanix_hole_spacing)
//   plate_w       plate width  in mm (across the belt)
//   plate_h       plate height in mm (up the belt)   — matches belt height
//   pilot_hole_d  M5 self-tap pilot
//
// Plate footprint:
//   plate_h = belt height (38mm for 2-row, 52mm for 3-row).
//   plate_w = kanix_grid_plate_w(cols) = hole_spacing*(cols-1) + 2*plate_margin
//             (plate_margin = 7 from common.scad — same margin accessories use).

// ----- 38mm belt (1.5" duty), 2 rows -----
kanix_grid_2x2 = [
    ["name",          "2x2"],
    ["hole_cols",      2],
    ["hole_rows",      2],
    ["hole_spacing",   kanix_hole_spacing],
    ["plate_w",        kanix_grid_plate_w(2)],   // 33.05
    ["plate_h",        38],
    ["pilot_hole_d",   kanix_screw_d]
];

kanix_grid_3x2 = [
    ["name",          "3x2"],
    ["hole_cols",      3],
    ["hole_rows",      2],
    ["hole_spacing",   kanix_hole_spacing],
    ["plate_w",        kanix_grid_plate_w(3)],   // 52.1
    ["plate_h",        38],
    ["pilot_hole_d",   kanix_screw_d]
];

kanix_grid_4x2 = [
    ["name",          "4x2"],
    ["hole_cols",      4],
    ["hole_rows",      2],
    ["hole_spacing",   kanix_hole_spacing],
    ["plate_w",        kanix_grid_plate_w(4)],   // 71.15
    ["plate_h",        38],
    ["pilot_hole_d",   kanix_screw_d]
];

// ----- 52mm belt (2" duty), 3 rows -----
kanix_grid_2x3 = [
    ["name",          "2x3"],
    ["hole_cols",      2],
    ["hole_rows",      3],
    ["hole_spacing",   kanix_hole_spacing],
    ["plate_w",        kanix_grid_plate_w(2)],   // 33.05
    ["plate_h",        52],
    ["pilot_hole_d",   kanix_screw_d]
];

kanix_grid_3x3 = [
    ["name",          "3x3"],
    ["hole_cols",      3],
    ["hole_rows",      3],
    ["hole_spacing",   kanix_hole_spacing],
    ["plate_w",        kanix_grid_plate_w(3)],   // 52.1
    ["plate_h",        52],
    ["pilot_hole_d",   kanix_screw_d]
];

kanix_grid_4x3 = [
    ["name",          "4x3"],
    ["hole_cols",      4],
    ["hole_rows",      3],
    ["hole_spacing",   kanix_hole_spacing],
    ["plate_w",        kanix_grid_plate_w(4)],   // 71.15
    ["plate_h",        52],
    ["pilot_hole_d",   kanix_screw_d]
];

// ============================================================================
// BELT PRESETS — clip-only (height, thickness, plate thickness, screw length)
// ============================================================================
//
// Field reference:
//   name             short id for fixtures
//   belt_height      mm; informational — matches the grid's plate_h
//   belt_thickness   mm; gap the clip wraps around the belt
//   plate_thickness  mm; thickness of the back plate (where bolts go)
//   screw_length     mm; bite depth into the accessory module (10mm screw -
//                    3mm head rest - 2mm plate passthrough = 8mm into module).

// ----- 38mm / 1.5" duty belts -----
kanix_belt_38x5_3 = [
    ["name",            "38x5.3"],
    ["belt_height",     38],
    ["belt_thickness",  5.3],
    ["plate_thickness", 5],
    ["screw_length",    8]
];

// ----- 52mm / 2" duty belts -----
kanix_belt_52x6_5 = [
    ["name",            "52x6.5"],
    ["belt_height",     52],
    ["belt_thickness",  6.5],
    ["plate_thickness", 5],
    ["screw_length",    8]
];

kanix_belt_52x12 = [
    ["name",            "52x12"],
    ["belt_height",     52],
    ["belt_thickness",  12],
    ["plate_thickness", 5],
    ["screw_length",    8]
];

// ============================================================================
// Legacy combined presets — DEPRECATED, do not use in new code
// ============================================================================
// These flatten a grid + belt into one bundle so existing accessory files
// (clicker_holder_*.scad, wuben-c3-holster.scad, etc.) keep rendering until
// they're migrated to take just a grid preset. New accessories should take
// kanix_grid_* directly; new plates use kanix_grid_* + kanix_belt_*.

kanix_preset_38x4 = [
    ["name",            "38x4"],
    ["plate_size",      38],
    ["plate_thickness", 4],
    ["belt_thickness",  4],
    ["belt_height",     51],
    ["hole_cols",       2],
    ["hole_rows",       2],
    ["hole_spacing",    kanix_hole_spacing],
    ["plate_w",         38],
    ["plate_h",         38],
    ["pilot_hole_d",    kanix_screw_d],
    ["screw_length",    3]
];

kanix_preset_52x65 = [
    ["name",            "52x6_5"],
    ["plate_size",      52],
    ["plate_thickness", 5.5],
    ["belt_thickness",  6.5],
    ["belt_height",     51],
    ["hole_cols",       3],
    ["hole_rows",       3],
    ["hole_spacing",    kanix_hole_spacing],
    ["plate_w",         52],
    ["plate_h",         52],
    ["pilot_hole_d",    kanix_screw_d],
    ["screw_length",    5]
];

// ============================================================================
// Accessor
// ============================================================================
// Look up a field by key. Errors loudly (undef) if the key is absent so a
// typo surfaces immediately instead of silently using a default.
function preset_get(preset, key) =
    let (hits = [for (kv = preset) if (kv[0] == key) kv[1]])
    hits[0];
