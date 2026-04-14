// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0 — https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Wuben C3 Flashlight Holster - Kanix Belt Mount
// Holds a Wuben C3 flashlight (121.5mm long, 26.5mm body diameter).
// Mounts to a Kanix belt clip.

include <BOSL2/std.scad>
include <BOSL2/rounding.scad>
include <common.scad>

kanix_grid_size = 3;
screw_depth     = 7.5;

// ===== Flashlight Parameters =====
light_d    = 26.5;            // Wuben C3 body diameter
wall       = 3;               // holster wall thickness
holster_od = light_d + wall * 2;  // 32.5mm

// ===== Plate Parameters =====
plate_thickness = 8;

plate_width  = kanix_plate_dim(kanix_grid_size);
plate_height = kanix_plate_dim(kanix_grid_size);

// ===== Holster Body Parameters =====
// Tube axis along Y, flashlight hangs down
// Extends 29mm below the lowermost hole center
grid_offset      = kanix_grid_offset(kanix_grid_size);
lowest_hole_y    = -grid_offset * kanix_hole_spacing;  // -19.05mm
holster_bottom_y = lowest_hole_y - 29;                    // -48.05mm
holster_top_y    = plate_height / 2;                      // top of plate
holster_length   = holster_top_y - holster_bottom_y;

// Tube center in Z: inner edge 1mm from plate back
holster_z = 1 + light_d / 2;

// ===== Flex Cutout Parameters =====
// Front cutout so holster can flex open for insertion
cutout_width    = 8;          // width of the opening
cutout_bottom_y = holster_bottom_y + 32;  // solid below this point

$fn = 64;

// ===== Modules =====

// Rounded rectangle plate with rounded top edges
// Oriented flat-back down on Z=0, top face at Z=plate_thickness
module kanix_plate() {
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
}

// Holster tube body with 1mm rounded outside edges at top and bottom
module holster_tube() {
    edge_r = 1;  // 2mm diameter = 1mm radius
    translate([0, holster_bottom_y, holster_z])
        rotate([-90, 0, 0])
            rotate_extrude()
                hull() {
                    square([holster_od/2 - edge_r, holster_length]);
                    translate([holster_od/2 - edge_r, edge_r])
                        circle(r = edge_r);
                    translate([holster_od/2 - edge_r, holster_length - edge_r])
                        circle(r = edge_r);
                }
}

// ===== Assembly =====
difference() {
    union() {
        kanix_plate();
        holster_tube();
    }

    // Flashlight bore (closed bottom, open top, flared opening)
    translate([0, holster_bottom_y + wall, holster_z])
        rotate([-90, 0, 0])
            cyl(d = light_d, l = holster_length - wall + 0.1,
                chamfer2 = -1, anchor = BOTTOM);

    // Screw holes - 6 holes: columns 0 and 2 (skip center column), all 3 rows
    for (col = [0, 2])
        for (row = [0 : kanix_grid_size - 1])
            translate([
                (col - grid_offset) * kanix_hole_spacing,
                (row - grid_offset) * kanix_hole_spacing,
                -0.1
            ])
                cylinder(d = kanix_screw_d, h = screw_depth + 0.1);

    // Front flex cutout - U-shape with chamfered edges on inner/outer surfaces
    cutout_len = holster_top_y - cutout_bottom_y + 0.1;
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
    translate([0, cutout_bottom_y + cutout_r, holster_z])
        offset_sweep(slot_path, height = holster_od,
            top = os_chamfer(width = cutout_chamfer),
            bottom = os_chamfer(width = cutout_chamfer),
            steps = 16);

    // Cut off anything protruding below plate back (Z=0)
    translate([0, 0, -holster_od])
        cube([holster_od + 1, holster_length * 3, holster_od * 2], center = true);
}

// Retention bumps - 4 hulled sphere pairs at 90° intervals in bottom 20mm of bore
// 1.5mm diameter, protrude 0.75mm into cavity. Added after bore subtraction so they survive.
bump_d = 1.5;
bump_r_offset = light_d / 2;
for (a = [0, 90, 180, 270])
    translate([0, holster_bottom_y + wall, holster_z])
        rotate([-90, 0, 0])
            translate([bump_r_offset * cos(a), bump_r_offset * sin(a), 0])
                hull() {
                    translate([0, 0, bump_d / 2])
                        sphere(d = bump_d, $fn = 16);
                    translate([0, 0, 20 - bump_d / 2])
                        sphere(d = bump_d, $fn = 16);
                }
