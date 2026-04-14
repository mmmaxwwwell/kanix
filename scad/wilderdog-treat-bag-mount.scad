// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Wilderdog Treat Bag Mount - Kanix Belt Mount
// Two plates connected by a print-in-place knuckle hinge.
// Each plate has 3 Kanix mounting holes (one column).
// Folds to hook onto a treat pouch carabiner loop.

include <common.scad>
use <hinge.scad>
holes_per_side       = 3;

// ===== Plate Parameters =====
plate_length    = 110;  // mm (long axis)
plate_width     = 30;   // mm (hinge axis)
plate_thickness = 3.65; // mm

// ===== Hinge Parameters =====
knuckle_diam = plate_thickness;
hinge_segs   = 7;
hinge_gap    = 0.2;

block_length = knuckle_diam/2 + hinge_gap/4;
block_height = plate_thickness;
block_offset = plate_length / 2 + block_length / 2;

module_offset = plate_length/2 + block_length + hinge_gap/2;

$fn = 64;

// ===== Modules =====
edge_r = plate_thickness / 2;
corner_r = 5; // mm, X-Y corner radius on leaf

module leaf_profile() {
    // Cross-section: rounded bottom edge, tall top to not clip hinge
    hull() {
        // Top flat edge
        translate([0, plate_thickness])
            square([plate_width, 0.02], center = true);
        // Bottom rounded corners
        for (x = [-plate_width/2 + edge_r, plate_width/2 - edge_r])
            translate([x, -plate_thickness/2 + edge_r])
                circle(r = edge_r);
    }
}

module leaf_outline() {
    // 2D outline of the leaf in X-Y
    hull() {
        // Square hinge-side edge
        translate([0, -plate_length/2 + 0.01])
            square([plate_width, 0.02], center = true);
        // Rounded far-end corners
        for (x = [-plate_width/2 + corner_r, plate_width/2 - corner_r])
            translate([x, plate_length/2 - corner_r])
                circle(r = corner_r);
    }
}

module leaf() {
    difference() {
        linear_extrude(height = plate_thickness, center = true)
            leaf_outline();

        for (i = [0 : holes_per_side - 1])
            translate([0, (i - (holes_per_side - 1) / 2) * kanix_hole_spacing, -plate_thickness / 2])
                cylinder(d = kanix_screw_d, h = plate_thickness + 2);
    }
}

module top_block(inner = false){
    translate([0, -block_offset, 0])
    translate([0, -block_length/2, block_height/2])
    rotate([0, 90, 0])
    hinge(
        length = plate_width,
        outer_diam = knuckle_diam,
        segments = hinge_segs,
        inner = inner,
        gap = hinge_gap
    ) {
        // Block in hinge-local coords: undo rotate then undo translate
        rotate([0, -90, 0])
        translate([0, block_length/2, -block_height/2])
            cube([plate_width, block_length, block_height], center = true);
    }
}

module half(inner = false){
    translate([0, 0, plate_thickness/2])
    intersection() {
        union() {
            leaf();
            top_block(inner);
        }
        // Clip everything to the rounded profile
        rotate([90, 0, 0])
            linear_extrude(height = plate_length * 2, center = true)
            leaf_profile();
    }
}

module back(){
    half(inner = true);
}

module front(){
    half();
}

rotate([0, 0, 180])
translate([0, module_offset, 0])
back();

translate([0, module_offset, 0])
front();
