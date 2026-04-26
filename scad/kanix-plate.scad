// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.

use <lib/hinge.scad>
use <lib/hinge2.scad>
include <lib/common.scad>

// Belt dimensions
belt_height = 51;      // mm (2" duty belt)
belt_thickness = 6.5;  // mm

// Plate dimensions
plate_size = 52;       // mm, square mounting_plate
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
hinge_gap = 0.3;

top_block_length = hinge_od/2 - hinge_gap/2;
top_block_height = plate_thickness + belt_thickness / 2;
top_block_offset = plate_size / 2 + top_block_length / 2;

bottom_block_length = 10;
bottom_block_offset = plate_size / 2 + bottom_block_length / 2;

module_offset = plate_size/2 + top_block_length + hinge_gap/2;

side_locking_tab_depth = 5;
rx_wall_width = 2;
tx_tip_cutoff = 1.5;
locking_tab_width = plate_size - side_locking_tab_depth*4 - hinge_gap * 2;

middle_clip_interface_depth = 4;
middle_clip_interface_diameter = plate_thickness * 0.75;
middle_clip_length = belt_thickness;



module plate_body() {
    translate([0, 0, plate_thickness/2])
    cube([plate_size, plate_size + 1, plate_thickness], center = true);
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

module latch_hinge_base_void(){
    translate([0,plate_size/2 + bottom_block_length - plate_thickness/2,plate_thickness/2])
    cube([locking_tab_width,plate_thickness,plate_thickness], center = true);
}

module latch_hinge_base(inner, angle = 0,cutout=false){
    translate([0,plate_size/2 + bottom_block_length - plate_thickness/2,plate_thickness/2])
    rotate([0,90,0])
    rotate([0,0,angle])
    hinge(
        gap = hinge_gap,
        length = locking_tab_width,
        outer_diam = plate_thickness,
        segments = 7,
        inner = inner,
        cutout = cutout
    );
}

module main_hinge_transform(){
    translate([0,-top_block_length/2,top_block_height/2])
    rotate([0, 90, 0])
    children();
}

module main_hinge(inner){
    main_hinge_transform()
    hinge(
        gap = hinge_gap,
        length = plate_size,
        outer_diam = hinge_od,
        segments = 7,
        inner = inner
    );
}

module our_hinge_cutout(inner){
    main_hinge_transform()
    hinge(
        gap = hinge_gap,
        length = plate_size,
        outer_diam = hinge_od,
        segments = 7,
        inner = inner,
        cutout = true
    );
}

module mounting_block(){
    rotate([0, -90, 0])
    translate([0, top_block_length/2, -top_block_height/2])
    cube([plate_size, top_block_length, top_block_height], center = true);
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
    translate([0, -top_block_offset, top_block_height / 2]){
        difference() {
            union() {
                translate([0, top_block_length/2, plate_thickness - top_block_height/2])
                right_angle_fillet(diameter = fillet_d, length = plate_size);
                difference() {
                    main_hinge_transform()
                    mounting_block();
                    our_hinge_cutout(inner);
                }
                main_hinge(inner);
            }
            translate([0,-top_block_length/2,-top_block_height/2])
            rotate([0,0,90])
            rotate([0,90,0])
            front_edge_fillet_feature();
            // // Cut screw hole insets through fillet material on the back plate
            if (inner)
                for (col = [0 : hole_cols - 1])
                    for (row = [0 : hole_rows - 1])
                        translate([
                            (col - (hole_cols - 1) / 2) * kanix_hole_spacing,
                            (row - (hole_rows - 1) / 2) * kanix_hole_spacing + top_block_offset,
                            -top_block_height / 2 - 0.5
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
    translate([0, bottom_block_offset, plate_thickness/2 ]){
        cube([plate_size, bottom_block_length, plate_thickness ], center = true);
    }
    
}

module front_cutout_feature(){
    offset = 2;
    translate([plate_size/2 - side_locking_tab_depth*0.75 -side_locking_tab_depth * 2,0,plate_thickness/2]){
        translate([offset/2,0,0])
        hull(){
            cylinder(d = side_locking_tab_depth * 1.5 - 2, h=plate_thickness + 1, center=true, $fn=32);
            translate([0,plate_size,0])
            cylinder(d = side_locking_tab_depth * 1.5 - 2, h=plate_thickness + 1, center=true, $fn=32);
            
        }
        hull(){
            translate([side_locking_tab_depth * 2.5/3,0,0]){
                cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness + 1, center=true, $fn=32);
                translate([0,plate_size/2 - side_locking_tab_depth * 0.75,0])
                cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness + 1, center=true, $fn=32);
            }

            translate([offset,0,0]){
                cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness + 1, center=true, $fn=32);
                    translate([0,plate_size/2 - side_locking_tab_depth * 0.75,0])
                cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness + 1, center=true, $fn=32);
            }
        }
    }
}

module front_cutout(){
    front_cutout_feature();
    mirror([1,0,0])
    front_cutout_feature();
}

module middle_clip_latch_feature(){
    channel_width = side_locking_tab_depth * 1.5 - 2;
    offset = 2;
    translate([
        plate_size/2 - side_locking_tab_depth*0.75 -side_locking_tab_depth * 2,
        -plate_size/2 - bottom_block_length + 2.5 ,
        plate_thickness/2]
    ){
        translate([offset/2,0,0]){
            translate([0,plate_size/2 - plate_thickness/2,0])
            cube([channel_width - hinge_gap * 2,bottom_block_length,plate_thickness], center = true);
        }
        hull(){
            translate([side_locking_tab_depth * 2.5/3 - hinge_gap, - hinge_gap,0]){
                translate([0,plate_size/2 - side_locking_tab_depth * 0.75 - 5,0])
                cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness, center=true, $fn=32);
                translate([0,plate_size/2 - side_locking_tab_depth * 0.75 ,0])
                cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness, center=true, $fn=32);
            }

            translate([offset + hinge_gap,-hinge_gap,0]){
                translate([0,plate_size/2 - side_locking_tab_depth * 0.75 - 5,0])
                cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness, center=true, $fn=32);
                translate([0,plate_size/2 - side_locking_tab_depth * 0.75,0])
                cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness, center=true, $fn=32);
            }
        }
    }
}

module middle_clip_latch(){
    middle_clip_latch_feature();
    mirror([1,0,0])
    middle_clip_latch_feature();
}


module latch_block_rx(){
    translate([plate_size/2 - side_locking_tab_depth/2,plate_size/2 + bottom_block_length/2,plate_thickness+belt_thickness/2]){
        difference(){
            //outer block
            cube([
                    side_locking_tab_depth,
                    bottom_block_length ,
                    belt_thickness
                ],
                center = true
            );
            //difference block
            translate([-tx_tip_cutoff/2,0,-belt_thickness/4])
            cube([
                    side_locking_tab_depth - tx_tip_cutoff,
                    bottom_block_length - rx_wall_width * 2 + 1,
                    belt_thickness/2 + hinge_gap+1
                ],
                center = true
            );
        }
    }
}

module latch_block_tx(){
    translate([plate_size/2 - side_locking_tab_depth*1.5,plate_size/2 + bottom_block_length/2,plate_thickness+belt_thickness/2]){
        cube([side_locking_tab_depth,bottom_block_length,belt_thickness],center = true);
        difference(){
            translate([side_locking_tab_depth/2,bottom_block_length/2 - rx_wall_width,0]){
                rotate([90,0,0])
                linear_extrude(height = bottom_block_length - rx_wall_width * 2)
                polygon(points = [
                    [0, 0],
                    [side_locking_tab_depth+1, 0],
                    [0, belt_thickness/2],
                ]);
            }
            translate([13.5,0,0])
            cube([15,15,15],center = true);
        }
    }
}

module front_edge_fillet_feature(){
    rotate([0, 0, 90])     
    right_angle_fillet(diameter = plate_thickness/2, length = plate_size*2);
}

module front_edge_fillet(){
    translate([plate_size/2,0,0])
    front_edge_fillet_feature();
    mirror([1,0,0])
    translate([plate_size/2,0,0])
    front_edge_fillet_feature();
    translate([0,plate_size/2 + bottom_block_length,0])
    rotate([0,0,90])
    front_edge_fillet_feature();
}

module middle_clip_protrustion(){
    sphere_offset = plate_size/6 - plate_thickness/6;
    hull(){
        translate([0,0,-sphere_offset])
        sphere(d = middle_clip_interface_diameter, $fn=6);
        translate([0,0,sphere_offset])
        sphere(d = middle_clip_interface_diameter, $fn=6);
    }
}

module middle_clip_bottom_block_protrustion_cutout()
{
    translate([0,plate_size/2 + bottom_block_length/2 + plate_thickness/2 - middle_clip_interface_depth/2,plate_thickness/2])
    cube([plate_size/2,plate_thickness + middle_clip_interface_depth,plate_thickness],center=true);
}

module middle_clip_bottom_block_hinge_cutout(){
    translate([0,plate_size/2 + bottom_block_length/2 + plate_thickness/2,plate_thickness/2]){
        cube([plate_size - side_locking_tab_depth * 4, plate_thickness + hinge_gap * 2, plate_thickness],center=true);
    }
}

module middle_clip_front_hinge_front_translate(){
    translate([0,plate_size/2 + bottom_block_length - plate_thickness/2,plate_thickness/2])
    rotate([0,90,0])
    children();
}

module middle_clip_front_hinge(inner = true, cutout = false){
    hinge2(
        gap = hinge_gap,
        length = locking_tab_width + hinge_gap * 2,
        outer_diam = plate_thickness,
        segments = 7,
        inner = inner,
        cutout = cutout
    );
}

module middle_clip_center_hinge(inner = true, cutout = false){
    hinge2(
        gap = hinge_gap,
        length = locking_tab_width,
        outer_diam = plate_thickness,
        segments = 7,
        inner = inner,
        cutout = cutout
    );
}

module middle_clip_middle_section(){
    difference(){
        union(){
            //inner hinge
            translate([0,plate_thickness/2,plate_thickness/2]){
                rotate([0,90,0])
                middle_clip_front_hinge(inner = false);
            }

            //outer hinge 
            translate([0,- middle_clip_length - plate_thickness/2,plate_thickness/2]){
                rotate([0,90,180])
                middle_clip_center_hinge(inner = false);
            }

            //plate
            translate([0,- middle_clip_length/2,plate_thickness/2]){
                cube([locking_tab_width ,middle_clip_length - hinge_gap * 2,plate_thickness], center = true);
            }
            translate([0,- middle_clip_length/2,plate_thickness*1.5 - middle_clip_interface_depth/4 - hinge_gap]){
                cube([locking_tab_width ,middle_clip_length - hinge_gap * 2,plate_thickness], center = true);
            }
        }
        translate([0,- middle_clip_length/2,plate_thickness*1.5 - middle_clip_interface_depth/4 - hinge_gap])
        translate([0,0,plate_thickness/2 - hinge_gap])
            rotate([0,90,0])
            rotate([0,0,90])
            middle_clip_protrustion();

    }
}

module middle_clip_end_section(){
    translate([0,0,plate_thickness/2])
    rotate([0,90,0])
    middle_clip_center_hinge(inner = true);
    
    translate([0,-middle_clip_interface_depth - 0.5, plate_thickness/2])
    cube([locking_tab_width, middle_clip_interface_depth - hinge_gap * 2,plate_thickness], center = true);
    
    translate([0,0,0])
    middle_clip_latch(); 
}

module front(){
    translate([0,plate_size/2 + middle_clip_interface_depth/4,plate_thickness + belt_thickness/2 ])
    rotate([0,90,0])
    middle_clip_protrustion();
    translate([0,plate_size/2 ,plate_thickness]){
        rotate([0,0,180])
        translate([0, middle_clip_interface_depth/4 ,0])
        right_angle_fillet(diameter = belt_thickness, length = locking_tab_width - side_locking_tab_depth * 2 - hinge_gap * 3);
        translate([0,0,belt_thickness/2])
        cube([locking_tab_width - side_locking_tab_depth * 2 - hinge_gap * 3,middle_clip_interface_depth/2,belt_thickness], center = true);
    }
    difference(){
        union(){
            plate_body();
            top_block();
            difference(){
                bottom_block();
                middle_clip_bottom_block_protrustion_cutout();
            }
        }
        front_cutout();
        front_edge_fillet();
    }
    latch_block_tx();
    mirror([1,0,0])
    latch_block_tx();
}

module back(){
    difference(){
        union(){
            mounting_plate();
            top_block(inner = true);
            difference(){
                bottom_block();
                middle_clip_bottom_block_hinge_cutout();
            }
        }
        front_edge_fillet();
    }
    latch_block_rx();
    mirror([1,0,0])
    latch_block_rx();

    middle_clip_front_hinge_front_translate()
    middle_clip_front_hinge();
}

// view = $preview ? "closed" : "closed";
view = $preview ? "open" : "open";

//open
if(view == "open"){
    translate([0, module_offset ,0])
    front();

    rotate([0,0,180])
    translate([0, module_offset ,0])
    back();

    translate([0,-module_offset - plate_size/2 - bottom_block_length,0])
    middle_clip_middle_section();

    translate([0,-module_offset - plate_size/2 - bottom_block_length - middle_clip_length - plate_thickness/2,0])
    middle_clip_end_section();
}

if(view == "closed"){
    translate([0,0,plate_thickness*2 + belt_thickness])
    rotate([0,180,0]){
        front();
    }
    back();

    translate([0,module_offset + bottom_block_length / 2 + plate_thickness/2 - hinge_gap* 4,middle_clip_length/2 + plate_thickness/2 - hinge_gap * 4])
    rotate([90,180,0])
    middle_clip_middle_section();

    translate([0, plate_size/2 + bottom_block_length - plate_thickness/2 ,plate_thickness + belt_thickness])
    middle_clip_end_section();
}