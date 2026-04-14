// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// MK3 Canister Holder - Kanix Belt Mount
// Mounts an MK-3 pepper spray canister to a Kanix belt clip.

// ===== Canister Parameters =====
canister_diameter  = 38.1;    // mm (1.5") measured
canister_height    = 114;     // mm (4.5")
canister_clearance = 0.4;     // mm per side (TPU slop compensation)

// ===== Holder Parameters =====
wall_thickness   = 3;         // mm
bottom_thickness = 3;         // mm
holder_height    = 80;        // mm (~70% of canister, easy to grab)
holder_inner_d   = canister_diameter + canister_clearance * 2;
holder_outer_d   = holder_inner_d + wall_thickness * 2;
drain_hole_d     = 8;         // mm drain hole in bottom
retention_lip    = 0.8;       // mm inward lip at top for retention
front_cutout_w   = 20;        // mm width of front thumb cutout
front_cutout_h   = 50;        // mm height of cutout from top edge down
front_cutout_r   = 5;         // mm corner radius for cutout

include <common.scad>

kanix_grid_size = 3;
screw_depth     = 15;          // mm depth for screw holes through hull

// ===== Mounting Plate Parameters =====
plate_thickness = 4;           // mm

plate_width  = kanix_plate_dim(kanix_grid_size);
plate_height = kanix_plate_dim(kanix_grid_size);

// Plate Y offset (back of holder + clearance)
plate_y = holder_outer_d / 2 + plate_thickness;

$fn = 64;

// ===== Modules =====

// Rounded rectangle plate shape (solid, no holes)
module plate_shape() {
    hull() {
        for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
            for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                translate([x, y, 0])
                    cylinder(r = plate_corner_r, h = plate_thickness);
    }
}

// ===== Assembly =====

difference() {
    union() {
        // Hull connecting holder cylinder and mounting plate
        hull() {
            // Holder outer cylinder
            cylinder(d = holder_outer_d, h = holder_height);

            // Plate solid shape at its position
            translate([0, plate_y, holder_height - plate_height / 2])
                rotate([90, 0, 0])
                plate_shape();
        }

        // Retention lip at the top
        if (retention_lip > 0) {
            translate([0, 0, holder_height - 1.5])
                difference() {
                    cylinder(d = holder_outer_d, h = 1.5);
                    translate([0, 0, -0.1])
                        cylinder(d = holder_inner_d - retention_lip * 2, h = 1.7);
                }
        }
    }

    // Canister bore (leave bottom solid, leave top for retention lip)
    translate([0, 0, bottom_thickness])
        cylinder(d = holder_inner_d, h = holder_height - bottom_thickness - 1.5);

    // Narrower bore at top for retention lip
    translate([0, 0, holder_height - 1.6])
        cylinder(d = holder_inner_d - retention_lip * 2, h = 2);

    // Drain hole in bottom
    translate([0, 0, -0.1])
        cylinder(d = drain_hole_d, h = bottom_thickness + 0.2);

    // Front thumb cutout for easy canister removal
    translate([0, -holder_outer_d / 2, holder_height - front_cutout_h])
        hull() {
            translate([-front_cutout_w / 2, -0.1, 0])
                cube([front_cutout_w, wall_thickness + 0.2, front_cutout_h + 0.1]);
            // Round the bottom of the cutout
            translate([0, wall_thickness / 2, 0])
                rotate([90, 0, 0])
                cylinder(d = front_cutout_w, h = wall_thickness + 0.2, center = true);
        }

    // Screw holes - 2x3 grid (skip middle column), drilled through plate + hull
    grid_offset = (kanix_grid_size - 1) / 2;
    for (col = [0, 2])
        for (row = [0 : kanix_grid_size - 1])
            translate([
                (col - grid_offset) * kanix_hole_spacing,
                plate_y + 0.1,
                holder_height - plate_height / 2 + (row - grid_offset) * kanix_hole_spacing
            ])
                rotate([90, 0, 0])
                cylinder(d = kanix_screw_d, h = screw_depth);
}
