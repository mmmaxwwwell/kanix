// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.

use <lib/hinge.scad>
include <lib/common.scad>

// Belt dimensions
belt_height = 51;      // mm (2" duty belt)
belt_thickness = 6.5;  // mm

// Plate dimensions
plate_size = 51;       // mm, square mounting_plate
plate_thickness = 5;   // mm

// M5 clearance hole (5.5mm clears M5 threads without interference)
bolt_hole_d = 5.5;

// Counterbore for M5 bolt heads
counterbore_d = 11.5;
counterbore_depth = 2.4;

// Hole grid: 3x3 pattern centered on mounting_plate
hole_cols = 3;
hole_rows = 3;

hinge_od = belt_thickness;
hinge_gap = 0.2;

block_length = hinge_od/2 - hinge_gap/2;
block_height = plate_thickness + belt_thickness / 2;
block_offset = plate_size / 2 + block_length / 2;

bottom_block_length = 8;
bottom_block_offset = plate_size / 2 + bottom_block_length / 2;

module_offset = plate_size/2 + block_length + hinge_gap/2;


module plate_body() {
    translate([-plate_size/2, -plate_size/2, 0])
        cube([plate_size, plate_size, plate_thickness]);
}

module bolt_hole() {
    cylinder(h = plate_thickness + 1, d = bolt_hole_d, center = false, $fn = 32);
    translate([0, 0, plate_thickness - counterbore_depth])
        cylinder(h = counterbore_depth + 1, d = counterbore_d, center = false, $fn = 48);
}

module mounting_plate() {
    difference() {
        plate_body();

        for (col = [0 : hole_cols - 1])
            for (row = [0 : hole_rows - 1])
                translate([
                    (col - (hole_cols - 1) / 2) * kanix_hole_spacing,
                    (row - (hole_rows - 1) / 2) * kanix_hole_spacing,
                    -0.5
                ])
                bolt_hole();
    }
}

module hinge_transform(){
    translate([0,-block_length/2,block_height/2])
    rotate([0, 90, 0])
    children();
}

module our_hinge(inner){
    hinge_transform()
    hinge(
        length = plate_size,
        outer_diam = hinge_od,
        segments = 7,
        inner = inner
    );
}

module our_hinge_cutout(inner){
    hinge_transform()
    hinge(
        length = plate_size,
        outer_diam = hinge_od,
        segments = 7,
        inner = inner,
        cutout = true
    );
}

module mounting_block(){
    rotate([0, -90, 0])
    translate([0, block_length/2, -block_height/2])
    cube([plate_size, block_length, block_height], center = true);
}

module right_angle_fillet(diameter, length){
    translate([0,diameter/2,diameter/2])
    difference() {
        cube([length, diameter, diameter], center = true);
        rotate([0,90,0])
        cylinder(d = diameter, h = length, center = true, $fn=32);

        translate([0,diameter/2,0])
        cube([length, diameter, diameter], center = true);

        translate([0,0,diameter/2])
        cube([length, diameter, diameter], center = true);

    }
}

fillet_d = 5;

module top_block(inner = false){
    translate([0, -block_offset, block_height / 2]){
        
        tri_base = plate_thickness/2;

        difference() {
            union() {
                translate([0, block_length/2, plate_thickness - block_height/2])
                right_angle_fillet(diameter = fillet_d, length = plate_size);
                difference() {
                    hinge_transform()
                    mounting_block();
                    our_hinge_cutout(inner);
                }
                our_hinge(inner);
            }
            // Chamfer the corner where the block meets the plate base
            translate([-plate_size/2 - 0.5, -block_length/2, -block_height/2])
            rotate([90,0,0])
            rotate([0, 90, 0])
            linear_extrude(height = plate_size + 1)
                polygon(points = [
                    [0, 0],
                    [tri_base, 0],
                    [0, tri_base],
                ]);
            // Cut screw hole insets through fillet material on the back plate
            if (inner)
                for (col = [0 : hole_cols - 1])
                    for (row = [0 : hole_rows - 1])
                        translate([
                            (col - (hole_cols - 1) / 2) * kanix_hole_spacing,
                            (row - (hole_rows - 1) / 2) * kanix_hole_spacing + block_offset,
                            -block_height / 2 - 0.5
                        ]) {
                            bolt_hole();
                            // Extend counterbore through fillet
                            translate([0, 0, plate_thickness - counterbore_depth])
                                cylinder(h = fillet_d + counterbore_depth + 1, d = counterbore_d, $fn = 48);
                        }
        }


    }
}


module bottom_block(){
    translate([0, bottom_block_offset, plate_thickness/2 + belt_thickness/2]){
        difference() {
            cube([plate_size, bottom_block_length, plate_thickness + belt_thickness ], center = true);
            cube([plate_size - bottom_block_length*2, bottom_block_length, plate_thickness + belt_thickness ], center = true);
        }
    }
    
}

module back(){
    mounting_plate();
    top_block(inner = true);
    // bottom_block();
}

module front(){
    plate_body();
    top_block();
    // bottom_block();
}

//open
translate([0, module_offset ,0])
front();

rotate([0,0,180])
translate([0, module_offset ,0])
back();

if ($preview) {
    //split
    translate([160,0,0]){
        rotate([0,0,180])
        translate([0, module_offset + 5 ,0])
        back();

        translate([0, module_offset + 5  ,0])
        front();
    }

    //closed
    translate([80,0,0])
    translate([0,0,plate_thickness*2 + belt_thickness])
    rotate([0,180,0]){
        front();
    }
    translate([80,0,0])
    back();
}
