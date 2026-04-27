// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Kanix Mounting Plate
//
// The flat back plate that accessories use to bolt onto a Kanix belt clip.
// Geometry: rounded square with a rounded top edge, drilled from the bottom
// face with a blind bolt-shaft clearance grid that does NOT break through
// the top face. No counterbore — just the shaft.
//
// Bottom face (Z=0) is the clip-side: bolts come up from the clip into the
// plate. Top face stays unbroken — better cosmetics and prints flat without
// bridging over hole tops.
//
// Usage:
//   use <lib/mounting-plate.scad>
//   include <lib/presets.scad>
//   mounting_plate(kanix_preset_52x65);

include <common.scad>
include <presets.scad>

// Render a back plate sized + drilled for the given preset.
//
// preset            — a kanix_preset_* bundle from lib/presets.scad
// thickness         — override preset's plate_thickness
// corner_r          — XY corner radius (default: common.scad's plate_corner_r)
// edge_r            — top-edge fillet radius (default: common.scad's plate_edge_r)
// screw_hole_depth  — blind drill depth measured from the bottom face up.
//                     Defaults to the preset's screw_length so the hole is
//                     exactly long enough for the screw it's specified for.
// drill_holes       — set false to omit the bolt grid
// cutout            — when true, output ONLY the bolt-hole cylinders (no
//                     body). Use this inside a parent difference() when the
//                     plate body has been replaced or reshaped (e.g. after
//                     a hull) and you still want the original bolt pattern
//                     punched through. The cylinders extend from below the
//                     bottom face up through the entire plate thickness.
module mounting_plate(
    preset,
    thickness         = undef,
    corner_r          = undef,
    edge_r            = undef,
    screw_hole_depth  = undef,
    drill_holes       = true,
    hole_cols         = undef,
    hole_rows         = undef,
    cutout            = false
) {
    plate_size = preset_get(preset, "plate_size");
    t          = thickness == undef ? preset_get(preset, "plate_thickness") : thickness;
    cr         = corner_r == undef ? plate_corner_r : corner_r;
    er         = edge_r   == undef ? plate_edge_r   : edge_r;
    // Default hole depth = preset's screw_length (single source of truth).
    hole_dep   = screw_hole_depth == undef
                 ? preset_get(preset, "screw_length")
                 : screw_hole_depth;

    // Plate footprint: a fraction of the preset's full square plate, sized
    // by row/col count vs. the preset's full grid. A 1-row clip on a 3-row
    // preset is plate_size tall on its long edge and plate_size * 1/3 on
    // its short edge — i.e. the "middle slice" of the full plate.
    cols      = hole_cols == undef ? preset_get(preset, "hole_cols") : hole_cols;
    rows      = hole_rows == undef ? preset_get(preset, "hole_rows") : hole_rows;
    full_cols = preset_get(preset, "hole_cols");
    full_rows = preset_get(preset, "hole_rows");
    w         = plate_size * cols / full_cols;
    h         = plate_size * rows / full_rows;

    // Sanity: there must be material above the hole top.
    assert(hole_dep < t,
        "screw_hole_depth must be < plate thickness (holes are blind)");

    if (cutout) {
        // Cutout mode: only the bolt-hole cylinders, sized to punch
        // through the entire plate thickness from below. Caller is
        // responsible for placing this inside a difference().
        plate_holes(preset, t + 0.2, cols, rows);
    } else {
        difference() {
            plate_body(w, h, t, cr, er);
            if (drill_holes) plate_holes(preset, hole_dep, cols, rows);
        }
    }
}

// Plate body: rounded square with a rounded top edge. Bottom face is flat
// (sits on the build plate); top face is filleted by edge_r.
module plate_body(w, h, t, cr, er) {
    hull() {
        for (x = [-w/2 + cr, w/2 - cr])
            for (y = [-h/2 + cr, h/2 - cr])
                translate([x, y, 0])
                    cylinder(r = cr, h = t - er);
        for (x = [-w/2 + cr, w/2 - cr])
            for (y = [-h/2 + cr, h/2 - cr])
                translate([x, y, t - er]) {
                    cylinder(r = cr - er, h = er);
                    sphere(r = er);
                }
    }
}

// Bolt grid: blind shaft-clearance hole drilled from the bottom face up to
// `hole_dep`. No counterbore — just the shaft. Pattern centered on origin.
module plate_holes(preset, hole_dep, cols, rows) {
    spacing    = preset_get(preset, "hole_spacing");
    pilot_d    = preset_get(preset, "pilot_hole_d");
    col_offset = (cols - 1) / 2;
    row_offset = (rows - 1) / 2;

    for (col = [0 : cols - 1])
        for (row = [0 : rows - 1])
            translate([
                (col - col_offset) * spacing,
                (row - row_offset) * spacing,
                -0.1   // poke through bottom for a clean boolean
            ])
                cylinder(d = pilot_d, h = hole_dep + 0.1, $fn = 32);
}
