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
knuckle_diam     = plate_thickness * 2;
end_knuckle_diam = plate_thickness * 2;
center_hinge_segs = 5;
end_hinge_segs    = 5;
hinge_gap        = 0.2;

block_length     = knuckle_diam/2 + hinge_gap/4;
block_height     = plate_thickness;
block_offset     = plate_length / 2 + block_length / 2;

end_block_length = end_knuckle_diam/2 + hinge_gap/4;
end_block_height = plate_thickness;
end_block_offset = plate_length / 2 + end_block_length / 2;

module_offset = plate_length/2 + block_length + hinge_gap/2;

$fn = 64;

// ===== Modules =====
edge_r = plate_thickness / 2;
corner_r = 5; // mm, X-Y corner radius on leaf

module leaf_profile() {
    // Cross-section: rounded bottom edge, tall top to not clip hinge
    hull() {
        // Top flat edge — tall enough to clear hinge barrel + arms
        translate([0, plate_thickness + end_knuckle_diam])
            square([plate_width, 0.02], center = true);
        // Bottom rounded corners
        for (x = [-plate_width/2 + edge_r, plate_width/2 - edge_r])
            translate([x, -plate_thickness/2 + edge_r])
                circle(r = edge_r);
    }
}

module leaf_outline() {
    // 2D outline of the leaf in X-Y — square on both ends for hinge blocks
    square([plate_width, plate_length], center = true);
}

module leaf(holes = true) {
    difference() {
        linear_extrude(height = plate_thickness, center = true)
            leaf_outline();

        if (holes)
            for (i = [0 : holes_per_side - 1])
                translate([0, (i - (holes_per_side - 1) / 2) * kanix_hole_spacing, -plate_thickness / 2])
                    cylinder(d = kanix_screw_d, h = plate_thickness + 2);
    }
}

module center_hinge_transform(){
    translate([0, -block_offset, 0])
    translate([0, -block_length/2, block_height/2])
    rotate([0, 90, 0])
    children();
}

module end_hinge_transform(){
    translate([0, end_block_offset, 0])
    translate([0, end_block_length/2, end_block_height/2])
    rotate([0, -90, 0])
    rotate([0, 0, 180])
    children();
}

module center_hinge(inner = false){
    center_hinge_transform()
    hinge(
        length = plate_width,
        outer_diam = knuckle_diam,
        segments = center_hinge_segs,
        inner = inner,
        gap = hinge_gap
    );
}

module end_hinge(inner = false){
    end_hinge_transform()
    hinge(
        length = plate_width,
        outer_diam = end_knuckle_diam,
        segments = end_hinge_segs,
        inner = inner,
        gap = hinge_gap,
        latch = true
    );
}

module center_hinge_cutout(inner = false){
    center_hinge_transform()
    hinge(
        length = plate_width,
        outer_diam = knuckle_diam,
        segments = center_hinge_segs,
        inner = inner,
        gap = hinge_gap,
        cutout = true
    );
}

module end_hinge_cutout(inner = false){
    end_hinge_transform()
    hinge(
        length = plate_width,
        outer_diam = end_knuckle_diam,
        segments = end_hinge_segs,
        inner = inner,
        gap = hinge_gap,
        cutout = true,
        latch = true
    );
}

module center_mounting_block(){
    rotate([0, -90, 0])
    translate([0, block_length/2, -block_height/2])
        cube([plate_width, block_length, block_height], center = true);
}

module end_mounting_block(){
    rotate([0, -90, 0])
    translate([0, end_block_length/2, -end_block_height/2])
        cube([plate_width, end_block_length, end_block_height], center = true);
}

module center_block(inner = false){
    difference() {
        center_hinge_transform()
        center_mounting_block();
        center_hinge_cutout(inner);
    }
    center_hinge(inner);
}

module end_block(inner = false){
    difference() {
        end_hinge_transform()
        end_mounting_block();
        end_hinge_cutout(inner);
    }
    end_hinge(inner);
}

module half(inner = false){
    translate([0, 0, plate_thickness/2])
    intersection() {
        union() {
            leaf(holes = !inner);
            center_block(inner);
            end_block(inner);
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

//open
translate([0, module_offset, 0])
front();

rotate([0, 0, 180])
translate([0, module_offset, 0])
back();

if ($preview) {
    //split
    translate([80, 0, 0]){
        rotate([0, 0, 180])
        translate([0, module_offset + 5, 0])
        back();

        translate([0, module_offset + 5, 0])
        front();
    }

    //closed
    translate([40, 0, 0]){
        translate([0, 0, plate_thickness*2])
        rotate([0, 180, 0]){
            front();
        }
        back();
    }
}
