// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
//
// Shared geometry for BioThane leash hole-punch jigs.
// One channel-cross-section, any length, with 2-hole rows at arbitrary Y
// positions. A "4-hole square" is just two rows 11.6mm apart.

// ===== Strap =====
strap_width      = 24.8;
strap_thickness  = 2.5;

// ===== Chicago screw / hole pattern =====
// Holes are 6mm but caps are 10mm, so spacing is driven by cap geometry.
//   3*gap + 2*cap_d = strap_width  →  gap = 1.6mm
hole_d           = 6.0;
cap_d            = 10.0;
gap              = (strap_width - 2 * cap_d) / 3;   // 1.6 mm
hole_pitch       = cap_d + gap;                     // 11.6 mm, center-to-center
edge_to_center   = gap + cap_d / 2;                 //  6.6 mm

// ===== Jig cross-section =====
wall              = 2.0;
jig_thickness     = 2 * strap_thickness;            // 5 mm
channel_clearance = 0.3;
channel_w         = strap_width + channel_clearance;
channel_d         = strap_thickness;
jig_w             = channel_w + 2 * wall;

inch              = 25.4;
eps               = 0.01;

// Punch jig with a 2-hole row at every Y in `hole_ys`.
// Holes sit at X = ±hole_pitch/2 (centered in the channel).
// Channel opens DOWNWARD (toward Z=0, the build plate).
module leash_jig(length, hole_ys) {
    difference() {
        translate([-jig_w/2, 0, 0])
            cube([jig_w, length, jig_thickness]);

        // Strap channel — open on both Y ends; opens DOWNWARD (Z=0 face)
        translate([-channel_w/2, -eps, -eps])
            cube([channel_w, length + 2*eps, channel_d + eps]);

        // Punch-guide holes
        for (y = hole_ys)
            for (x = [-hole_pitch/2, hole_pitch/2])
                translate([x, y, -eps])
                    cylinder(d = hole_d, h = jig_thickness + 2*eps);
    }
}
