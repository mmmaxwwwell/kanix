// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Slip Lead Wrap Post - Kanix Belt Mount
// Post for securely wrapping a 5/8" x 5' slip lead.
// Mounts to a Kanix belt clip.

include <BOSL2/std.scad>
include <BOSL2/rounding.scad>
include <lib/common.scad>

kanix_grid_size = 3;
screw_depth     = 7.5;

// ===== Post Parameters =====
post_diameter = 20;
post_height   = 10;

// ===== Plate Parameters =====
plate_thickness = 8;

plate_width  = kanix_plate_dim(kanix_grid_size);
plate_height = kanix_plate_dim(kanix_grid_size);

$fn = 64;

// ===== Modules =====

// Rounded rectangle plate with rounded top edges
// Oriented flat-back down on Z=0, top face at Z=plate_thickness
module kanix_plate() {
    difference() {
        // Plate body with rounded top edges
        hull() {
            // Bottom layer at Z=0 (flat back, sharp edges)
            for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
                for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                    translate([x, y, 0])
                        cylinder(r = plate_corner_r, h = plate_thickness - plate_edge_r);

            // Top rounded edge
            for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
                for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                    translate([x, y, plate_thickness - plate_edge_r])
                        cylinder(r = plate_corner_r - plate_edge_r, h = plate_edge_r);

            // Rounded top edge spheres at corners
            for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
                for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                    translate([x, y, plate_thickness - plate_edge_r])
                        sphere(r = plate_edge_r);
        }

        // Screw holes - full 3x3 grid, blind holes from back (bottom) face
        grid_offset = (kanix_grid_size - 1) / 2;
        for (col = [0 : kanix_grid_size - 1])
            for (row = [0 : kanix_grid_size - 1])
                translate([
                    (col - grid_offset) * kanix_hole_spacing,
                    (row - grid_offset) * kanix_hole_spacing,
                    -0.1
                ])
                    cylinder(d = kanix_screw_d, h = screw_depth + 0.1);
    }
}

// ===== Cutout Parameters =====
cutout_width = 5;
cutout_edge_r = 2;            // rounded edges on the cutout

// ===== Assembly =====
kanix_plate();

fillet_r = 5;
cone_edge_r = 1;
// Full-size 30° cone height, then scale to 3/4
full_cone_h = (plate_width / 2 + 10 - post_diameter / 2) / tan(30);
cone_h = full_cone_h * 3 / 4;
// Top radius shrinks to maintain 30° angle
cone_top_r = post_diameter / 2 + cone_h * tan(30);
// Original 45° cone height (preserves top-of-cone position)
old_cone_h = (plate_width / 2 + 10) - post_diameter / 2;
cone_base_z = plate_thickness + post_height + old_cone_h - cone_h;
total_post_h = post_height + old_cone_h;

difference() {
    union() {
        // Post with 5mm concave fillets at base and top
        translate([0, 0, plate_thickness])
            rotate_extrude() {
                // Main post rectangle
                square([post_diameter / 2, post_height]);
                // Base fillet: curves outward from post wall to plate
                difference() {
                    square([post_diameter / 2 + fillet_r, fillet_r]);
                    translate([post_diameter / 2 + fillet_r, fillet_r])
                        circle(r = fillet_r);
                }
            }

        // Cone flaring out at top of post, with 1mm rounded top outer edge
        translate([0, 0, plate_thickness + post_height])
            rotate_extrude()
                hull() {
                    // Bottom of cone (matches post radius)
                    square([post_diameter / 2, 0.01]);
                    // Main cone body up to where rounding starts
                    translate([0, cone_h - cone_edge_r])
                        square([cone_top_r - cone_edge_r, 0.01]);
                    // Rounded top outer edge
                    translate([cone_top_r - cone_edge_r, cone_h - cone_edge_r])
                        circle(r = cone_edge_r);
                }
    }

    // Center cutout slot with rounded edges using BOSL2 offset_sweep
    slot_len = cone_top_r * 2 + 2;  // long enough to cut through everything
    slot_path = [
        [-cutout_width/2, -slot_len/2],
        [ cutout_width/2, -slot_len/2],
        [ cutout_width/2,  slot_len/2],
        [-cutout_width/2,  slot_len/2]
    ];
    translate([0, 0, plate_thickness + post_height + 10])
        offset_sweep(slot_path,
            height = cone_h - 10 + 0.1,
            bottom = os_circle(r = cutout_edge_r),
            top = os_circle(r = cutout_edge_r),
            steps = 16);
}
