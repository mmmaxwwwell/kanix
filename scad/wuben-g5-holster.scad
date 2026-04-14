// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Wuben G5 Flashlight Holster - Kanix Belt Mount
// Holds a Wuben G5 EDC flashlight (62mm long, 37mm wide, 15mm thick).
// Mounts to a Kanix belt clip.

include <BOSL2/std.scad>
include <BOSL2/rounding.scad>
include <common.scad>

kanix_grid_size = 3;
screw_depth     = 7.5;

// ===== Flashlight Parameters =====
light_w   = 37;              // body width
light_t   = 15;              // body thickness

// ===== Wall Thicknesses =====
wall_side   = 3;
wall_front  = 1.5;
wall_bottom = 3;

// ===== Plate Parameters =====
plate_thickness = 8;

plate_width  = kanix_plate_dim(kanix_grid_size);
plate_height = kanix_plate_dim(kanix_grid_size);
grid_offset  = kanix_grid_offset(kanix_grid_size);

// ===== Pocket Dimensions =====
cavity_w = 38;
cavity_t = 14;
cavity_len = 40;

// Outer shell
pocket_w = cavity_w + wall_side * 2;
pocket_t = cavity_t + wall_front;  // back wall is the plate

// Vertical positioning: centered on plate
pocket_bottom = -(cavity_len + wall_bottom) / 2;
pocket_top    = pocket_bottom + cavity_len + wall_bottom;
pocket_len    = pocket_top - pocket_bottom;

// Z positioning: pocket back face at plate front
pocket_back_z = plate_thickness;

// ===== Flex Cutout =====
cutout_width    = 10;
cutout_bottom_y = -40;

$fn = 64;

// ===== Modules =====

module kanix_plate() {
    hull() {
        for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
            for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                translate([x, y, 0])
                    cylinder(r = plate_corner_r, h = plate_thickness - plate_edge_r);
        for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
            for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                translate([x, y, plate_thickness - plate_edge_r]) {
                    cylinder(r = plate_corner_r - plate_edge_r, h = plate_edge_r);
                    sphere(r = plate_edge_r);
                }
    }
}

// Pocket outer shell - rounded on front edges only, sharp at plate junction
module pocket_outer() {
    cr = 2;  // corner radius on front edges
    translate([0, pocket_bottom, pocket_back_z])
        hull() {
            // Back two edges - sharp (against plate)
            for (x = [-pocket_w/2, pocket_w/2])
                translate([x, 0, 0])
                    rotate([-90, 0, 0])
                        cylinder(r = 0.01, h = pocket_len, $fn = 4);
            // Front two edges - rounded
            for (x = [-pocket_w/2 + cr, pocket_w/2 - cr])
                translate([x, 0, pocket_t - cr])
                    rotate([-90, 0, 0])
                        cylinder(r = cr, h = pocket_len);
        }
}

// ===== Assembly =====
difference() {
    union() {
        kanix_plate();
        pocket_outer();
    }

    // Cavity - centered in pocket, open at top
    translate([0, pocket_bottom + wall_bottom, pocket_back_z])
        hull() {
            cr = 1;
            for (x = [-cavity_w/2 + cr, cavity_w/2 - cr])
                for (z = [cr, cavity_t - cr])
                    translate([x, 0, z])
                        rotate([-90, 0, 0])
                            cylinder(r = cr, h = pocket_len - wall_bottom + 0.2);
        }

    // Screw holes - all 9 holes
    for (col = [0 : kanix_grid_size - 1])
        for (row = [0 : kanix_grid_size - 1])
            translate([
                (col - grid_offset) * kanix_hole_spacing,
                (row - grid_offset) * kanix_hole_spacing,
                -0.1
            ])
                cylinder(d = kanix_screw_d, h = screw_depth + 0.1);

    // Front flex cutout
    cutout_len = pocket_top - cutout_bottom_y + 0.1;
    cutout_r = cutout_width / 2;
    cutout_chamfer = 1;
    n_arc = 16;
    slot_path = concat(
        [[cutout_r, 0],
         [cutout_r, cutout_len - cutout_r],
         [-cutout_r, cutout_len - cutout_r],
         [-cutout_r, 0]],
        [for (i = [1:n_arc-1])
            let(a = 180 + i * 180 / n_arc)
            [cutout_r * cos(a), cutout_r * sin(a)]
        ]
    );
    // Centered on front face of pocket
    translate([0, cutout_bottom_y + cutout_r, pocket_back_z + cavity_t/2])
        offset_sweep(slot_path, height = pocket_t,
            top = os_chamfer(width = cutout_chamfer),
            bottom = os_chamfer(width = cutout_chamfer),
            steps = 16);

    // Cut off anything below plate back (Z=0)
    translate([0, 0, -50])
        cube([200, 200, 100], center = true);
}

// Retention bumps - 4 bumps on front and back faces
bump_d = 1.5;
for (z = [pocket_back_z, pocket_back_z + cavity_t])  // back and front
    for (x_off = [-cavity_w/4, cavity_w/4])           // two per face
        translate([x_off, pocket_bottom + wall_bottom, z])
            rotate([-90, 0, 0])
                hull() {
                    translate([0, 0, bump_d/2])
                        sphere(d = bump_d, $fn = 16);
                    translate([0, 0, 20 - bump_d/2])
                        sphere(d = bump_d, $fn = 16);
                }
