// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Kanix Mounting Plate
//
// The flat back plate that accessories use to bolt onto a Kanix belt clip.
// Geometry: rounded rectangle with a rounded top edge, drilled from the
// bottom face with a blind bolt-shaft clearance grid that does NOT break
// through the top face. No counterbore — just the shaft.
//
// Bottom face (Z=0) is the clip-side: bolts come up from the clip into the
// plate. Top face stays unbroken — better cosmetics and prints flat without
// bridging over hole tops.
//
// Usage:
//   include <lib/presets.scad>
//   use <lib/mounting-plate.scad>
//   mounting_plate(kanix_grid_3x2);

include <common.scad>
include <presets.scad>

// Default plate thickness for accessory back-plates. Accessories don't carry
// a belt preset, so they can't read plate_thickness from one. Override per
// accessory if you need more bolt-bite depth.
mounting_plate_default_thickness = 4;
mounting_plate_default_screw_depth = 3;

// Render a back plate sized + drilled for the given grid preset.
//
// grid              — a kanix_grid_* bundle from lib/presets.scad
// thickness         — plate thickness in mm (default: 4)
// corner_r          — XY corner radius (default: common.scad's plate_corner_r)
// edge_r            — top-edge fillet radius (default: common.scad's plate_edge_r)
// screw_hole_depth  — blind drill depth measured from the bottom face up
//                     (default: 3mm). Must be < thickness.
// drill_holes       — set false to omit the bolt grid
// hole_cols/rows    — override the grid's cols/rows to render a partial plate
//                     (e.g. a 1-row strip cut from a 3x3 grid). When set,
//                     plate width/height scale proportionally.
// cutout            — when true, output ONLY the bolt-hole cylinders (no
//                     body). Use this inside a parent difference() when the
//                     plate body has been replaced or reshaped (e.g. after
//                     a hull) and you still want the original bolt pattern
//                     punched through.
module mounting_plate(
    grid,
    thickness         = undef,
    corner_r          = undef,
    edge_r            = undef,
    screw_hole_depth  = undef,
    drill_holes       = true,
    hole_cols         = undef,
    hole_rows         = undef,
    cutout            = false
) {
    t          = thickness == undef ? mounting_plate_default_thickness : thickness;
    cr         = corner_r  == undef ? plate_corner_r : corner_r;
    er         = edge_r    == undef ? plate_edge_r   : edge_r;
    hole_dep   = screw_hole_depth == undef ? mounting_plate_default_screw_depth : screw_hole_depth;

    // Partial-plate slicing: caller can render a subset of the grid by passing
    // hole_cols/hole_rows < the grid's own counts. Plate w/h scale linearly
    // off the grid's full footprint so the "slice" footprint matches.
    full_cols  = preset_get(grid, "hole_cols");
    full_rows  = preset_get(grid, "hole_rows");
    cols       = hole_cols == undef ? full_cols : hole_cols;
    rows       = hole_rows == undef ? full_rows : hole_rows;
    full_w     = preset_get(grid, "plate_w");
    full_h     = preset_get(grid, "plate_h");
    w          = full_w * cols / full_cols;
    h          = full_h * rows / full_rows;

    assert(hole_dep < t,
        "screw_hole_depth must be < plate thickness (holes are blind)");

    if (cutout) {
        plate_holes(grid, t + 0.2, cols, rows);
    } else {
        difference() {
            plate_body(w, h, t, cr, er);
            if (drill_holes) plate_holes(grid, hole_dep, cols, rows);
        }
    }
}

// Plate body: rounded rectangle with a rounded top edge. Bottom face is flat
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
module plate_holes(grid, hole_dep, cols, rows) {
    spacing    = preset_get(grid, "hole_spacing");
    pilot_d    = preset_get(grid, "pilot_hole_d");
    col_offset = (cols - 1) / 2;
    row_offset = (rows - 1) / 2;

    for (col = [0 : cols - 1])
        for (row = [0 : rows - 1])
            translate([
                (col - col_offset) * spacing,
                (row - row_offset) * spacing,
                -0.1
            ])
                cylinder(d = pilot_d, h = hole_dep + 0.1, $fn = 32);
}
