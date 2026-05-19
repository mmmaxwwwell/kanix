// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Leash hole-punch jig for 1" (25.4mm) Chicago-screw blocks on 24.8mm BioThane.
// Punches a 2x2 square of 6mm holes for 5mm Chicago screws.
// Channel is open-ended along the strap direction so longer straps feed through.

// ===== Strap =====
strap_width      = 24.8;   // mm, BioThane width
strap_thickness  = 2.5;    // mm, BioThane thickness

// ===== Hole pattern =====
// Square of 4 holes for Chicago screws. Holes are 6mm but caps are 10mm,
// so spacing is governed by cap geometry, not hole geometry:
//   3*gap + 2*cap_d = strap_width   →   gap = (24.8 - 20) / 3 = 1.6mm
// Hole center-to-center  = cap_d + gap          = 11.6 mm
// Edge-to-hole center    = gap + cap_d/2        =  6.6 mm
hole_d           = 6.0;    // mm, punch diameter
cap_d            = 10.0;   // mm, Chicago-screw cap diameter
gap              = (strap_width - 2 * cap_d) / 3;   // 1.6 mm
hole_pitch       = cap_d + gap;                     // 11.6 mm, center-to-center
edge_to_center   = gap + cap_d / 2;                 //  6.6 mm

// ===== Jig =====
wall             = 2.0;    // mm, side walls + end padding around hole pattern
jig_thickness    = 2 * strap_thickness;  // 5 mm total
channel_clearance = 0.3;   // mm, sliding fit for the strap in the channel

channel_w        = strap_width + channel_clearance;     // X, across strap
channel_d        = strap_thickness;                     // Z, channel depth

jig_w            = channel_w + 2 * wall;                // X
// Y length: square pattern → same edge-to-hole and hole-to-hole as X,
// so total jig length along the strap = strap_width by construction
// (3*gap + 2*cap_d = strap_width).
jig_l            = strap_width;

eps              = 0.01;

$fn = 64;

module jig() {
    difference() {
        // Solid block, centered in X and Y, sitting on Z=0
        translate([-jig_w/2, -jig_l/2, 0])
            cube([jig_w, jig_l, jig_thickness]);

        // Strap channel: open-ended in Y, runs full length of the jig
        translate([-channel_w/2, -jig_l/2 - eps, -eps])
            cube([channel_w, jig_l + 2*eps, channel_d + eps]);

        // 4 punch-guide holes through the top of the jig.
        // Centers sit at ±hole_pitch/2 in both axes (square pattern, sized
        // for 10mm caps with equal cap-to-cap and cap-to-edge gaps).
        for (x = [-hole_pitch/2, hole_pitch/2])
            for (y = [-hole_pitch/2, hole_pitch/2])
                translate([x, y, -eps])
                    cylinder(d = hole_d, h = jig_thickness + 2*eps);
    }
}

// Flip so the punch-side (top) sits on the build plate — solid flat face
// is on Z=0 for printing; the strap channel faces up.
translate([0, 0, jig_thickness])
    rotate([180, 0, 0])
        jig();
