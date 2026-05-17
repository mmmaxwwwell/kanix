// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Kanix Belt Clip — parametric.
//
// The belt clip wraps a belt and provides a bolt grid that accessory modules
// bolt onto. Holes are through-drilled with counterbores for M5 cap heads on
// the back face (away from the body). Plate footprint and bolt grid come from
// the preset, so the same accessories that mount the kanix_plate also mount
// this clip.
//
// Starting point: bare counterbored plate. Clip body, hinge, latch features
// get added incrementally.

include <common.scad>
include <presets.scad>

module belt_clip(
    preset,
    belt_width        = 38,    // mm — belt's vertical dimension
    belt_thickness    = 4,     // mm — belt's thickness; used as bore diameter (tolerance baked in)
    plate_thickness   = undef, // override preset's plate_thickness
    plate_w           = undef, // override preset's plate_size for the X (belt-direction) edge
    plate_h           = undef, // override preset's plate_size for the Y (cross-belt) edge
    hole_cols         = undef, // override preset's hole_cols
    hole_rows         = undef, // override preset's hole_rows
    bolt_hole_d       = 5.5,   // M5 clearance
    counterbore_d     = 11.5,  // M5 cap-head counterbore
    counterbore_depth = undef, // mm — counterbore depth; defaults to plate_thickness - 2.5 (leaves 2.5mm under the bore)
    belt_wall         = undef  // mm — wall around the belt bore; defaults to plate_thickness
) {
    preset_size       = preset_get(preset, "plate_size");
    plate_thickness   = plate_thickness == undef ? preset_get(preset, "plate_thickness") : plate_thickness;
    counterbore_depth = counterbore_depth == undef ? plate_thickness - 2.5 : counterbore_depth;
    plate_w         = plate_w == undef ? preset_size : plate_w;
    plate_h         = plate_h == undef ? preset_size : plate_h;
    hole_cols       = hole_cols == undef ? preset_get(preset, "hole_cols") : hole_cols;
    hole_rows       = hole_rows == undef ? preset_get(preset, "hole_rows") : hole_rows;
    hole_spacing    = preset_get(preset, "hole_spacing");

    bore_d = belt_thickness;
    wall   = belt_wall == undef ? plate_thickness : belt_wall;
    hump_d = bore_d + wall * 2;

    module plate_body() {
        translate([0, 0, plate_thickness/2])
        cube([plate_w, plate_h, plate_thickness], center = true);
    }

    module bolt_hole(through_counterbore = false) {
        cylinder(h = plate_thickness + 1, d = bolt_hole_d, center = false, $fn = 32);
        cb_h = through_counterbore ? plate_thickness + 1 : counterbore_depth + 1;
        cb_z = through_counterbore ? -0.5 : plate_thickness - counterbore_depth;
        translate([0, 0, cb_z])
            cylinder(h = cb_h, d = counterbore_d, center = false, $fn = 48);
    }

    module drilled_plate(through_counterbore = false) {
        difference() {
            plate_body();
            for (col = [0 : hole_cols - 1])
                for (row = [0 : hole_rows - 1])
                    translate([
                        (col - (hole_cols - 1) / 2) * hole_spacing,
                        (row - (hole_rows - 1) / 2) * hole_spacing,
                        -0.5
                    ])
                    bolt_hole(through_counterbore);
        }
    }

    // Half-cylinder hump along the +Y edge, axis along X (belt direction).
    module belt_hump() {
        hump_z = plate_thickness + plate_thickness/2;
        difference() {
            intersection() {
                translate([0, plate_h/2, hump_z])
                rotate([0, 90, 0])
                cylinder(h = plate_w, d = hump_d, center = true, $fn = 64);

                translate([0, plate_h/2 + hump_d/4, hump_z])
                cube([plate_w + 1, hump_d/2 + 0.5, hump_d + 1], center = true);
            }

            // Belt bore — through-hole the full plate width along X.
            translate([0, plate_h/2, hump_z])
            rotate([0, 90, 0])
            cylinder(h = plate_w + 1, d = bore_d, center = true, $fn = 64);
        }
    }

    // -y hump with a 0.3mm lengthwise split at x=0, plus a 30° wedge cut on
    // the outside that goes halfway through the wall as a lead-in for the belt.
    module belt_hump_split_neg_y() {
        bore_z   = plate_thickness + plate_thickness/2;
        y_outer  = -plate_h/2 - hump_d/2;
        y_mid    = -plate_h/2 - wall/2;          // halfway through the outside wall
        wedge_depth = (hump_d/2 - bore_d/2) / 2; // halfway through the wall, radially
        // 30° total included angle ⇒ ±15° flanks ⇒ half-width = depth * tan(15).
        flare_hw = wedge_depth * tan(15);

        difference() {
            mirror([0, 1, 0]) belt_hump();

            // Lengthwise split.
            translate([0, -plate_h/2, bore_z])
                cube([plate_w + 1, hump_d + 1, 0.3], center = true);

            // 30° wedge cut, extruded along X (lengthwise). Profile in 2D
            // pre-rotate: X axis ↔ world Z, Y axis ↔ world Y.
            translate([0, 0, bore_z])
            rotate([0, 90, 0])
            linear_extrude(height = plate_w + 1, center = true)
            polygon(points = [
                [+flare_hw, y_outer - 0.5],
                [-flare_hw, y_outer - 0.5],
                [0,         y_mid],
            ]);
        }
    }

    // Main plate (with bolt grid) + half-cylinder belt humps on both edges.
    union() {
        drilled_plate();
        belt_hump();
        belt_hump_split_neg_y();
    }

    // Second plate above the first, separated by one belt_thickness so the
    // belt sandwiches between them. Bolt grid aligned in X/Y; screws pass
    // straight through both plates.
    translate([0, 0, plate_thickness + belt_thickness])
        drilled_plate(through_counterbore = true);
}
