// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Pepper Spray Dual Holster - Kanix Belt Mount
// Holds two pepper spray canisters (45mm tall, 22mm diameter).
// Mounts to a Kanix belt clip.

include <BOSL2/std.scad>
include <BOSL2/rounding.scad>
include <lib/common.scad>

kanix_grid_size = 3;
screw_depth     = 7.5;

// ===== Canister Parameters =====
canister_d    = 23.2;            // pepper spray bore diameter (22mm actual + 1.2mm clearance, matches C3 tolerance)
canister_h    = 45;              // holder height
wall          = 3;               // holster wall thickness
holster_od    = canister_d + wall * 2;  // 28mm

// ===== Spacing =====
canister_spacing = canister_d + wall * 2 + 12;  // center-to-center: od + gap

// ===== Plate Parameters =====
plate_thickness = 8;

plate_width  = kanix_plate_dim(kanix_grid_size);
plate_height = kanix_plate_dim(kanix_grid_size);

// ===== Holster Body Parameters =====
// Tubes sit on top of the plate, bottoms aligned so canisters
// hang the same distance from plate bottom.
grid_offset = kanix_grid_offset(kanix_grid_size);

// Holster sits on top of the plate (starts at plate_thickness in Z)
holster_bottom_y = -plate_height / 2;
holster_top_y    = plate_height / 2;

// Tube center in Z: sits on top of the plate, sunk 2mm into it
holster_z = plate_thickness + holster_od / 2 - 2;

// ===== Flex Cutout Parameters =====
cutout_width    = 8;
cutout_bottom_y = holster_bottom_y + 16;  // solid below this point

$fn = 64;

// ===== Modules =====

// Rounded rectangle plate with rounded top edges
module kanix_plate() {
    hull() {
        for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
            for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                translate([x, y, 0])
                    cylinder(r = plate_corner_r, h = plate_thickness - plate_edge_r);

        for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
            for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                translate([x, y, plate_thickness - plate_edge_r])
                    cylinder(r = plate_corner_r - plate_edge_r, h = plate_edge_r);

        for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
            for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                translate([x, y, plate_thickness - plate_edge_r])
                    sphere(r = plate_edge_r);
    }
}

// Single holster tube body with 1mm rounded outside edges at top and bottom
// Oriented along Y axis, sitting on top of the plate
module holster_tube(x_offset) {
    edge_r = 1;
    translate([x_offset, holster_bottom_y, holster_z])
        rotate([-90, 0, 0])
            rotate_extrude()
                hull() {
                    square([holster_od/2 - edge_r, canister_h + wall]);
                    translate([holster_od/2 - edge_r, edge_r])
                        circle(r = edge_r);
                    translate([holster_od/2 - edge_r, canister_h + wall - edge_r])
                        circle(r = edge_r);
                }
}

// Hulled bridge between the two tubes for rigidity
module holster_bridge() {
    hull() {
        for (side = [-1, 1])
            translate([side * canister_spacing / 2, holster_bottom_y, holster_z])
                rotate([-90, 0, 0])
                    cylinder(d = holster_od, h = canister_h + wall);
    }
}


// ===== Assembly =====
rotate([90, 0, 0]) {
    difference() {
        union() {
            kanix_plate();
            for (side = [-1, 1])
                holster_tube(side * canister_spacing / 2);
            holster_bridge();
        }

        // Canister bores (closed bottom, open top, flared opening)
        for (side = [-1, 1])
            translate([side * canister_spacing / 2, holster_bottom_y + wall, holster_z])
                rotate([-90, 0, 0])
                    cyl(d = canister_d, l = canister_h + 0.1,
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

        // Front flex cutouts - U-shape with chamfered edges for each tube
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
        for (side = [-1, 1])
            translate([side * canister_spacing / 2, cutout_bottom_y + cutout_r, holster_z])
                offset_sweep(slot_path, height = holster_od,
                    top = os_chamfer(width = cutout_chamfer),
                    bottom = os_chamfer(width = cutout_chamfer),
                    steps = 16);

        // Cut off anything protruding below plate back (Z=0)
        translate([0, 0, -holster_od])
            cube([canister_spacing + holster_od + 1, (canister_h + wall) * 3, holster_od * 2], center = true);
    }

    // Retention bumps - 4 hulled sphere pairs at 90° intervals in bottom 30mm of bore
    // 1.5mm diameter, protrude 0.75mm into cavity.
    bump_d = 1.5;
    bump_r_offset = canister_d / 2;
    for (side = [-1, 1])
        for (a = [45, 135, 225, 315])
            translate([side * canister_spacing / 2, holster_bottom_y + wall, holster_z])
                rotate([-90, 0, 0])
                    translate([bump_r_offset * cos(a), bump_r_offset * sin(a), 0])
                        hull() {
                            translate([0, 0, bump_d / 2])
                                sphere(d = bump_d, $fn = 16);
                            translate([0, 0, 30 - bump_d / 2])
                                sphere(d = bump_d, $fn = 16);
                        }
}
