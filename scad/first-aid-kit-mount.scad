// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// First Aid Kit Mount - Kanix Belt Mount
// Simple mounting plate with rounded edges.
// Single row, two holes (skipping center).
// Center cutout for strap/webbing pass-through.

include <BOSL2/std.scad>
include <lib/common.scad>

// ===== Plate Parameters =====
plate_thickness = 8;          // mm
plate_corner_r  = 2;          // mm edge radius (override default of 4)

// ===== Cutout Parameters =====
cutout_width    = 24;         // mm along X axis
cutout_depth    = 3;          // mm from top face
cutout_corner_r = 2;          // mm inside corner radius

$fn = 64;

// ===== Modules =====

// Rounded mounting bar with configurable hole count (2 or 3)
module kanix_bar(holes = 2, thickness = plate_thickness, corner_r = plate_corner_r, margin = plate_margin) {
    hole_positions = holes == 3
        ? [-1, 0, 1]
        : [-1, 1];

    width  = kanix_hole_spacing * 2 + margin * 2;
    height = margin * 2;

    difference() {
        minkowski() {
            cube([
                width  - corner_r * 2,
                height - corner_r * 2,
                thickness - corner_r * 2
            ], center = true);
            sphere(r = corner_r);
        }

        for (col = hole_positions)
            translate([col * kanix_hole_spacing, 0, 0])
                cylinder(d = kanix_screw_d, h = thickness + 1, center = true);
    }
}

// Mounting bar with a center cutout for strap/webbing pass-through
module kanix_bar_with_cutout(holes = 2, thickness = plate_thickness, corner_r = plate_corner_r, margin = plate_margin,
                                cut_width = cutout_width, cut_depth = cutout_depth, cut_corner_r = cutout_corner_r) {
    height = margin * 2;

    difference() {
        kanix_bar(holes = holes, thickness = thickness, corner_r = corner_r, margin = margin);

        translate([0, 0, thickness / 2 - cut_depth])
            cuboid([cut_width, height + 1, cut_depth + cut_corner_r],
                   rounding = cut_corner_r,
                   edges = [BOTTOM+LEFT, BOTTOM+RIGHT, TOP+LEFT, TOP+RIGHT],
                   anchor = BOTTOM);
    }
}

// Perpendicular bar margin (narrower to leave more meat on horizontal piece)
perp_margin = plate_margin - 2; // mm margin for perpendicular bars (4mm narrower total)

// Clearance for lap joint fit
lap_clearance = 0.2;

// ===== Interlock Teeth =====
interlock_teeth   = 16;         // total teeth around the ring (8 per bar)
interlock_depth   = 1.5;          // mm height of each tooth
interlock_id      = kanix_screw_d + 1.5;  // mm inner diameter (clearance around screw)
interlock_od      = 10;         // mm outer diameter
interlock_clearance = 0.15;     // mm radial clearance per side

// Ring of radial teeth, even=true for even-numbered teeth, even=false for odd
module interlock_ring(even = true) {
    tooth_angle = 360 / interlock_teeth;
    ir = interlock_id / 2;
    or_ = interlock_od / 2;

    for (i = [0 : interlock_teeth - 1])
        if ((i % 2 == 0) == even)
            rotate([0, 0, i * tooth_angle])
                linear_extrude(interlock_depth)
                    polygon([
                        [ir * cos(-tooth_angle / 2 + interlock_clearance),
                         ir * sin(-tooth_angle / 2 + interlock_clearance)],
                        [or_ * cos(-tooth_angle / 2 + interlock_clearance),
                         or_ * sin(-tooth_angle / 2 + interlock_clearance)],
                        [or_ * cos(tooth_angle / 2 - interlock_clearance),
                         or_ * sin(tooth_angle / 2 - interlock_clearance)],
                        [ir * cos(tooth_angle / 2 - interlock_clearance),
                         ir * sin(tooth_angle / 2 - interlock_clearance)]
                    ]);
}

// Pocket cutout for receiving opposing interlock teeth (oversized for clearance)
module interlock_pocket(even = true) {
    tooth_angle = 360 / interlock_teeth;
    ir = interlock_id / 2 - interlock_clearance;
    or_ = interlock_od / 2 + interlock_clearance;

    for (i = [0 : interlock_teeth - 1])
        if ((i % 2 == 0) == even)
            rotate([0, 0, i * tooth_angle])
                linear_extrude(interlock_depth + interlock_clearance)
                    polygon([
                        [ir * cos(-tooth_angle / 2 - interlock_clearance),
                         ir * sin(-tooth_angle / 2 - interlock_clearance)],
                        [or_ * cos(-tooth_angle / 2 - interlock_clearance),
                         or_ * sin(-tooth_angle / 2 - interlock_clearance)],
                        [or_ * cos(tooth_angle / 2 + interlock_clearance),
                         or_ * sin(tooth_angle / 2 + interlock_clearance)],
                        [ir * cos(tooth_angle / 2 + interlock_clearance),
                         ir * sin(tooth_angle / 2 + interlock_clearance)]
                    ]);
}

// ===== Assembled Piece Modules =====

// Horizontal bar with lap joint slots and interlock teeth
module horizontal_piece() {
    union() {
        difference() {
            kanix_bar_with_cutout(holes = 2);

            // Cut bottom-half slots using actual perpendicular bar profile
            for (sign = [1, -1])
                translate([sign * kanix_hole_spacing, 0, 0])
                    rotate([0, 0, 90])
                        intersection() {
                            cuboid([200, 200, plate_thickness / 2 + lap_clearance], anchor = TOP);
                            minkowski() {
                                cube([
                                    (kanix_hole_spacing * 2 + perp_margin * 2) - plate_corner_r * 2,
                                    perp_margin * 2 - plate_corner_r * 2,
                                    plate_thickness - plate_corner_r * 2
                                ], center = true);
                                sphere(r = plate_corner_r + lap_clearance / 2);
                            }
                        }

            // Cut pockets for perpendicular piece's odd teeth
            for (sign = [1, -1])
                translate([sign * kanix_hole_spacing, 0, 0])
                    interlock_pocket(even = false);
        }

        // Add even teeth protruding down into each slot
        for (sign = [1, -1])
            translate([sign * kanix_hole_spacing, 0, -interlock_depth])
                interlock_ring(even = true);
    }
}

// Perpendicular bar with lap joint notch and interlock teeth
module perpendicular_piece() {
    union() {
        difference() {
            kanix_bar(holes = 3, margin = perp_margin);

            // Cut top-half notch using actual horizontal bar profile
            rotate([0, 0, 90])
                intersection() {
                    cuboid([200, 200, plate_thickness / 2 + lap_clearance], anchor = BOTTOM);
                    minkowski() {
                        cube([
                            (kanix_hole_spacing * 2 + plate_margin * 2) - plate_corner_r * 2,
                            plate_margin * 2 - plate_corner_r * 2,
                            plate_thickness - plate_corner_r * 2
                        ], center = true);
                        sphere(r = plate_corner_r + lap_clearance / 2);
                    }
                }

            // Cut pocket for horizontal piece's even teeth
            translate([0, 0, -(interlock_depth + interlock_clearance)])
                interlock_pocket(even = true);
        }

        // Add odd teeth protruding up from the notch surface
        interlock_ring(even = false);
    }
}

// ===== Render, print layout =====
print_gap = 10;  // mm between pieces
bar_width = kanix_hole_spacing * 2 + plate_margin * 2;

// Horizontal piece, flipped 180 on X so cutout side on bed, teeth face up
translate([0, 0, plate_thickness / 2])
    rotate([180, 0, 0])
        horizontal_piece();

// Perpendicular piece 1, teeth face up (notch side on bed)
translate([0, -(plate_margin + print_gap + perp_margin), plate_thickness / 2])
    perpendicular_piece();

// Perpendicular piece 2, teeth face up (notch side on bed)
translate([0, plate_margin + print_gap + perp_margin, plate_thickness / 2])
    perpendicular_piece();


// // Horizontal piece, flipped 180 on X so cutout side on bed, teeth face up
// translate([0, 0, plate_thickness / 2])
// horizontal_piece();

// // Perpendicular piece 1, teeth face up (notch side on bed)
// translate([-kanix_hole_spacing, 0, plate_thickness / 2])
//     rotate([0,0,90])
//     perpendicular_piece();

// // Perpendicular piece 2, teeth face up (notch side on bed)
// translate([kanix_hole_spacing, 0, plate_thickness / 2])
//     rotate([0,0,90])
//     perpendicular_piece();