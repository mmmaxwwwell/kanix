// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.

use <hinge.scad>
use <hinge2.scad>
include <common.scad>
include <presets.scad>

// Preset-driven entry point. Plates in scad/plates/ call this.
// Only handles square grids today (2x2, 3x3); rectangular grids (3x2, 4x2,
// 4x3) will fail the assert below until kanix_plate is reworked to support
// non-square plates.
module kanix_plate_from_presets(grid, belt, view = "open") {
    // plate_w is derived from the bolt grid (kanix_grid_plate_w in common.scad).
    // plate_h is the belt height. Both are owned by the plate module here, not
    // duplicated on the grid preset side, so changes only happen in one place.
    kanix_plate(
        belt_height     = preset_get(belt, "belt_height"),
        belt_thickness  = preset_get(belt, "belt_thickness"),
        plate_w         = kanix_grid_plate_w(preset_get(grid, "hole_cols")),
        plate_h         = preset_get(belt, "belt_height"),
        plate_thickness = preset_get(belt, "plate_thickness"),
        hole_cols       = preset_get(grid, "hole_cols"),
        hole_rows       = preset_get(grid, "hole_rows"),
        view            = view
    );
}

module kanix_plate(
    belt_height = 51,        // mm (2" duty belt)
    belt_thickness = 6.5,    // mm
    plate_w = 52,            // mm, X dimension (across the belt)
    plate_h = 52,            // mm, Y dimension (along the belt)
    plate_thickness = 5,     // mm
    bolt_hole_d = 5.5,       // M5 clearance hole
    counterbore_d = 11.5,    // Counterbore for M5 bolt heads
    hole_cols = 3,           // Number of bolt-hole columns
    hole_rows = 3,           // Number of bolt-hole rows
    main_hinge_segments = undef,         // undef = auto-size to match 3x3 52mm width
    latch_hinge_segments = undef,        // undef = auto-size to match 3x3 52mm width
    middle_clip_hinge_segments = undef,  // undef = auto-size to match 3x3 52mm width
    view = "open"            // "open" or "closed"
) {
    counterbore_depth = 2.4;

    hinge_od = belt_thickness;
    hinge_gap = 0.3;

    top_block_length = hinge_od/2 - hinge_gap/2;
    top_block_height = plate_thickness + belt_thickness / 2;
    top_block_offset = plate_h / 2 + top_block_length / 2;

    bottom_block_length = 10;
    bottom_block_offset = plate_h / 2 + bottom_block_length / 2;

    module_offset = plate_h/2 + top_block_length + hinge_gap/2;

    side_locking_tab_depth = 5;
    rx_wall_width = 2;
    tx_tip_cutoff = 1.5;
    locking_tab_width = plate_w - side_locking_tab_depth*4 - hinge_gap * 2;

    // Auto-size hinge segments so every plate's segment width stays close to
    // the 3x3 52mm reference. Two distinct targets:
    //   - main hinge (front↔back belt hinge) spans plate_w → 52/7 ≈ 7.4286
    //   - latch + middle-clip hinges span locking_tab_width → 31.4/7 ≈ 4.4857
    // Minimum 3 segments so the hinge still functions on small plates.
    main_segment_target  = 52 / 7;            // ≈ 7.4286 mm
    latch_segment_target = (52 - 5*4 - 0.3*2) / 7;  // = 31.4 / 7 ≈ 4.4857 mm
    // Round to nearest, force odd (hinges must alternate inner/outer and end
    // on the same side they start), min 3.
    function _to_odd(n) = (n % 2 == 0) ? n + 1 : n;
    auto_main_segments  = max(3, _to_odd(round(plate_w / main_segment_target)));
    auto_latch_segments = max(3, _to_odd(round(locking_tab_width / latch_segment_target)));
    _main_hinge_segments        = is_undef(main_hinge_segments)        ? auto_main_segments  : main_hinge_segments;
    _latch_hinge_segments       = is_undef(latch_hinge_segments)       ? auto_latch_segments : latch_hinge_segments;
    _middle_clip_hinge_segments = is_undef(middle_clip_hinge_segments) ? auto_latch_segments : middle_clip_hinge_segments;

    middle_clip_interface_depth = 4;
    middle_clip_interface_diameter = plate_thickness * 0.75;
    middle_clip_length = belt_thickness;

    fillet_d = 5;

    module plate_body() {
        translate([0, 0, plate_thickness/2])
        cube([plate_w, plate_h + 1, plate_thickness], center = true);
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
        translate([0,plate_h/2 + bottom_block_length - plate_thickness/2,plate_thickness/2])
        cube([locking_tab_width,plate_thickness,plate_thickness], center = true);
    }

    module latch_hinge_base(inner, angle = 0,cutout=false){
        translate([0,plate_h/2 + bottom_block_length - plate_thickness/2,plate_thickness/2])
        rotate([0,90,0])
        rotate([0,0,angle])
        hinge(
            gap = hinge_gap,
            length = locking_tab_width,
            outer_diam = plate_thickness,
            segments = _latch_hinge_segments,
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
            length = plate_w,
            outer_diam = hinge_od,
            segments = _main_hinge_segments,
            inner = inner
        );
    }

    module our_hinge_cutout(inner){
        main_hinge_transform()
        hinge(
            gap = hinge_gap,
            length = plate_w,
            outer_diam = hinge_od,
            segments = _main_hinge_segments,
            inner = inner,
            cutout = true
        );
    }

    module mounting_block(){
        rotate([0, -90, 0])
        translate([0, top_block_length/2, -top_block_height/2])
        cube([plate_w, top_block_length, top_block_height], center = true);
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

    module top_block(inner = false){
        translate([0, -top_block_offset, top_block_height / 2]){
            difference() {
                union() {
                    translate([0, top_block_length/2, plate_thickness - top_block_height/2])
                    right_angle_fillet(diameter = fillet_d, length = plate_w);
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
            cube([plate_w, bottom_block_length, plate_thickness ], center = true);
        }

    }

    module front_cutout_feature(){
        offset = 2;
        translate([plate_w/2 - side_locking_tab_depth*0.75 -side_locking_tab_depth * 2,0,plate_thickness/2]){
            translate([offset/2,0,0])
            hull(){
                cylinder(d = side_locking_tab_depth * 1.5 - 2, h=plate_thickness + 1, center=true, $fn=32);
                translate([0,plate_h,0])
                cylinder(d = side_locking_tab_depth * 1.5 - 2, h=plate_thickness + 1, center=true, $fn=32);

            }
            hull(){
                translate([side_locking_tab_depth * 2.5/3,0,0]){
                    cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness + 1, center=true, $fn=32);
                    translate([0,plate_h/2 - side_locking_tab_depth * 0.75,0])
                    cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness + 1, center=true, $fn=32);
                }

                translate([offset,0,0]){
                    cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness + 1, center=true, $fn=32);
                        translate([0,plate_h/2 - side_locking_tab_depth * 0.75,0])
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
            plate_w/2 - side_locking_tab_depth*0.75 -side_locking_tab_depth * 2,
            -plate_h/2 - bottom_block_length + 2.5 ,
            plate_thickness/2]
        ){
            translate([offset/2,0,0]){
                translate([0,plate_h/2 - plate_thickness/2,0])
                cube([channel_width - hinge_gap * 2,bottom_block_length,plate_thickness], center = true);
            }
            hull(){
                translate([side_locking_tab_depth * 2.5/3 - hinge_gap, - hinge_gap,0]){
                    translate([0,plate_h/2 - side_locking_tab_depth * 0.75 - 5,0])
                    cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness, center=true, $fn=32);
                    translate([0,plate_h/2 - side_locking_tab_depth * 0.75 ,0])
                    cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness, center=true, $fn=32);
                }

                translate([offset + hinge_gap,-hinge_gap,0]){
                    translate([0,plate_h/2 - side_locking_tab_depth * 0.75 - 5,0])
                    cylinder(d = side_locking_tab_depth * 1.5, h=plate_thickness, center=true, $fn=32);
                    translate([0,plate_h/2 - side_locking_tab_depth * 0.75,0])
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
        translate([plate_w/2 - side_locking_tab_depth/2,plate_h/2 + bottom_block_length/2,plate_thickness+belt_thickness/2]){
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
        translate([plate_w/2 - side_locking_tab_depth*1.5,plate_h/2 + bottom_block_length/2,plate_thickness+belt_thickness/2]){
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
        // Length spans the longer plate edge so the rotated feature covers both
        // axes when reused on top/bottom and sides — overshoot is trimmed by
        // the surrounding plate body.
        rotate([0, 0, 90])
        right_angle_fillet(diameter = 5, length = max(plate_w, plate_h)*2);
    }

    module front_edge_fillet(){
        translate([plate_w/2,0,0])
        front_edge_fillet_feature();
        mirror([1,0,0])
        translate([plate_w/2,0,0])
        front_edge_fillet_feature();
        translate([0,plate_h/2 + bottom_block_length,0])
        rotate([0,0,90])
        front_edge_fillet_feature();
    }

    module middle_clip_protrustion(){
        sphere_offset = locking_tab_width - side_locking_tab_depth * 2 - hinge_gap * 3 - middle_clip_interface_diameter;
        hull(){
            translate([0,0,-sphere_offset/2])
            sphere(d = middle_clip_interface_diameter, $fn=6);
            translate([0,0,sphere_offset/2])
            sphere(d = middle_clip_interface_diameter, $fn=6);
        }
    }

    module middle_clip_bottom_block_protrustion_cutout()
    {
        translate([0,plate_h/2 + bottom_block_length/2,plate_thickness/2])
        cube([plate_w - side_locking_tab_depth*4,bottom_block_length + middle_clip_interface_depth*2,plate_thickness],center=true);
    }

    module middle_clip_bottom_block_hinge_cutout(){
        translate([0,plate_h/2 + bottom_block_length/2 + plate_thickness/2,plate_thickness/2]){
            cube([plate_w - side_locking_tab_depth * 4, plate_thickness + hinge_gap * 2, plate_thickness],center=true);
        }
    }

    module middle_clip_front_hinge_front_translate(){
        translate([0,plate_h/2 + bottom_block_length - plate_thickness/2,plate_thickness/2])
        rotate([0,90,0])
        children();
    }

    module middle_clip_front_hinge(inner = true, cutout = false){
        hinge2(
            gap = hinge_gap,
            length = locking_tab_width + hinge_gap * 2,
            outer_diam = plate_thickness,
            segments = _middle_clip_hinge_segments,
            inner = inner,
            cutout = cutout
        );
    }

    module middle_clip_center_hinge(inner = true, cutout = false){
        hinge2(
            gap = hinge_gap,
            length = locking_tab_width,
            outer_diam = plate_thickness,
            segments = _middle_clip_hinge_segments,
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
                    intersection(){
                        cube([locking_tab_width ,middle_clip_length - hinge_gap * 2,plate_thickness], center = true);
                        // 45° chamfer on the two top X-end edges (2mm)
                        rotate([90,0,0])
                        linear_extrude(height = middle_clip_length - hinge_gap * 2, center = true)
                        polygon(points = [
                            [-locking_tab_width/2,           -plate_thickness/2],
                            [ locking_tab_width/2,           -plate_thickness/2],
                            [ locking_tab_width/2,            plate_thickness/2 - 2],
                            [ locking_tab_width/2 - 2,        plate_thickness/2],
                            [-locking_tab_width/2 + 2,        plate_thickness/2],
                            [-locking_tab_width/2,            plate_thickness/2 - 2]
                        ]);
                    }
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
        translate([0,plate_h/2 + middle_clip_interface_depth/4,plate_thickness + belt_thickness/2 ])
        rotate([0,90,0])
        middle_clip_protrustion();
        translate([0,plate_h/2 ,plate_thickness]){
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

    if(view == "open"){
        translate([0, module_offset ,0])
        front();

        rotate([0,0,180])
        translate([0, module_offset ,0])
        back();

        translate([0,-module_offset - plate_h/2 - bottom_block_length,0])
        middle_clip_middle_section();

        translate([0,-module_offset - plate_h/2 - bottom_block_length - middle_clip_length - plate_thickness/2,0])
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

        translate([0, plate_h/2 + bottom_block_length - plate_thickness/2 ,plate_thickness + belt_thickness])
        middle_clip_end_section();
    }
}

kanix_plate(view = $preview ? "open" : "open");
