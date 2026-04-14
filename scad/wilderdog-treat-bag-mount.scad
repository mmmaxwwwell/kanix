// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Wilderdog Treat Bag Mount - Kanix Belt Mount
// Two plates connected by a print-in-place knuckle hinge.
// Each plate has 3 Kanix mounting holes (one column).
// Folds to hook onto a treat pouch carabiner loop.

include <BOSL2/std.scad>
include <BOSL2/hinges.scad>
include <common.scad>
holes_per_side       = 3;

// ===== Plate Parameters =====
plate_length    = 110;  // mm (long axis)
plate_width     = 30;   // mm (hinge axis)
plate_thickness = 3.65; // mm

// ===== Hinge Parameters =====
knuckle_diam = plate_thickness * 2;
hinge_segs   = 9;
give         = 0.35;
end_space    = 0.6;  // gap between plates at hinge
pin_d        = 2.5; // printed pin diameter

$fn = 64;

// ===== Modules =====
module leaf() {
    difference() {
        // Plate body: width along X, length along Y, thickness along Z
        cube([plate_width, plate_length, plate_thickness], center = true);

        // Mounting holes through Z
        ycopies(n = holes_per_side, spacing = kanix_hole_spacing)
            translate([0, 0, -plate_thickness / 2])
                cylinder(d = kanix_screw_d, h = plate_thickness + 2);
    }
}

translate([0, 0, -plate_thickness / 2]){
    translate([0,plate_length/2 + end_space + knuckle_diam/2,0])
        leaf();
    translate([0,-(plate_length/2 + end_space) + -knuckle_diam/2,0])
        leaf();
}

rotate([90, 0, 0]) {
    rotate([0, 180, 0])
    translate([0,0,-(knuckle_diam/2 + end_space)])
    knuckle_hinge(length = plate_width, segs = hinge_segs-2,
                offset = knuckle_diam/2 + end_space, inner = false,
                knuckle_diam = knuckle_diam,
                arm_height = 0,
                arm_angle = 90, clear_top = true, fill = false,
                pin_diam = 1.5, gap = give);
    translate([0,0,-(knuckle_diam/2 + end_space)])
    knuckle_hinge(length = plate_width, segs = hinge_segs-2,
                offset = knuckle_diam/2 + end_space, inner = true,
                knuckle_diam = knuckle_diam,
                arm_height = 0,
                arm_angle = 90, clear_top = true, fill = false,
                pin_diam = 2.65, gap = give);
}



// Hinge pin
rotate([0, 90, 0])
    cylinder(d = pin_d, h = plate_width, center = true);
