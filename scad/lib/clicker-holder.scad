// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Clicker Holder — Kanix Belt Mount
//
// Holds a rectangular clicker (default 52.2 x 33 x 18 mm). Pocket bottom is
// flush with the plate's bottom edge so it prints opening-up without supports.
// The pocket carries its own back wall — the clicker is typically taller than
// the plate, so the plate alone can't seal the cavity. Front cutout
// intentionally omitted — callers add their own.

include <common.scad>
include <presets.scad>
use <mounting-plate.scad>

// Render a clicker holder mounted to the given Kanix preset.
//
// preset       — kanix_preset_* bundle from lib/presets.scad
// clicker_h    — clicker height (Y, vertical along belt)
// clicker_w    — clicker width  (X, across belt)
// clicker_d    — clicker depth  (Z, away from plate)
// wall_side    — wall thickness on left/right of cavity
// wall_front   — wall thickness on the outside (front) face
// wall_back    — wall thickness behind the cavity (against the plate)
// wall_bottom  — wall thickness below the cavity (closed bottom)
// plate_t      — override plate thickness; defaults to preset's plate_thickness
module clicker_holder(
    preset,
    clicker_h   = 52.2,
    clicker_w   = 33,
    clicker_d   = 18,
    wall_side   = 3,
    wall_front  = 1.5,
    wall_back   = 1.5,
    wall_bottom = 3,
    plate_t     = undef
) {
    plate_size = preset_get(preset, "plate_size");
    cols       = preset_get(preset, "hole_cols");
    rows       = preset_get(preset, "hole_rows");
    spacing    = preset_get(preset, "hole_spacing");
    pt         = plate_t == undef ? preset_get(preset, "plate_thickness") : plate_t;

    // Plate footprint (matches mounting_plate's grow-with-grid logic).
    grid_w   = (cols - 1) * spacing + plate_margin * 2;
    grid_h   = (rows - 1) * spacing + plate_margin * 2;
    plate_w  = max(plate_size, grid_w);
    plate_h  = max(plate_size, grid_h);

    // Cavity is the clicker dims (no clearance — caller can bump dims if needed).
    cavity_w   = clicker_w;
    cavity_t   = clicker_d;
    cavity_len = clicker_h;

    // Outer pocket shell. Pocket carries its own back wall so the cavity is
    // sealed even where the pocket extends above the plate's top edge.
    pocket_w   = cavity_w + wall_side * 2;
    pocket_t   = cavity_t + wall_front + wall_back;
    pocket_bottom = -plate_h / 2;          // flush with plate bottom edge
    pocket_top    = pocket_bottom + cavity_len + wall_bottom;
    pocket_len    = pocket_top - pocket_bottom;
    // Sink the pocket into the plate by wall_back so the cavity floor sits
    // flush with the plate's front face (the back wall of the cavity is
    // formed by the plate itself plus the sunken portion of the pocket).
    pocket_back_z = pt - wall_back;
    cavity_back_z = pocket_back_z + wall_back;

    // Default cap thickness used by mounting_plate (t - 1mm). We re-derive
    // it here so the hole-drill subtraction matches.
    hole_dep = pt - 1;

    // U-arc cutout geometry (shared with bumps so they stay co-centered).
    arc_or       = 23 / 2;
    arc_kerf     = 0.2;
    arc_ir       = arc_or - arc_kerf;
    arc_bottom_y = pocket_bottom + wall_bottom + 3.5;
    arc_center_y = arc_bottom_y + arc_or;
    arc_slot_len = 15;

    // Spherical-cap bump geometry: 20mm chord diameter, 6mm sagitta.
    bump_d = 20;
    bump_h = 6;
    bump_R = (pow(bump_d / 2, 2) + pow(bump_h, 2)) / (2 * bump_h);
    bump_y = arc_center_y;

    rotate([90, 0, 0]) {
        union() {
        difference() {
            union() {
                // Hull plate + pocket into a single fused, smoothly-blended body.
                hull() {
                    mounting_plate(preset, thickness = pt, drill_holes = false);
                    pocket_outer(pocket_w, pocket_t, pocket_len, pocket_bottom, pocket_back_z, pt);
                }

                // Outward-facing bump on the front face, dome in +Z.
                bump_z0 = pocket_back_z + pocket_t;
                intersection() {
                    translate([0, bump_y, bump_z0 + bump_h - bump_R])
                        sphere(r = bump_R, $fn = 96);
                    translate([-bump_d, bump_y - bump_d, bump_z0])
                        cube([bump_d * 2, bump_d * 2, bump_h]);
                }
            }

            // Bolt grid (drilled into the fused body, since we suppressed it
            // inside mounting_plate above).
            plate_holes(preset, hole_dep);

            // U-shaped slot through the front face: 180° arc + two upward
            // 0.2mm kerf slots, bottom 1.5mm above the cavity floor.
            // Cut from outside the front face through into the cavity.
            arc_z_lo = cavity_back_z - 0.1;
            arc_z_hi = pocket_back_z + pocket_t + 1;
            arc_z_h  = arc_z_hi - arc_z_lo;
            for (sx = [-1, 1])
                translate([sx * (arc_ir + arc_kerf / 2) - arc_kerf / 2,
                           arc_center_y,
                           arc_z_lo])
                    cube([arc_kerf, arc_slot_len, arc_z_h]);

            translate([0, arc_center_y, 0])
                intersection() {
                    difference() {
                        translate([0, 0, arc_z_lo])
                            cylinder(r = arc_or, h = arc_z_h, $fn = 96);
                        translate([0, 0, arc_z_lo - 0.1])
                            cylinder(r = arc_ir, h = arc_z_h + 0.2, $fn = 96);
                    }
                    // Keep only the lower half (y <= 0 in arc-local coords)
                    // so the slot opens upward like a U.
                    translate([-(arc_or + 1), -arc_or - 1, arc_z_lo - 0.1])
                        cube([(arc_or + 1) * 2, arc_or + 1.01, arc_z_h + 0.2],
                             center = false);
                }

            // Diamond cutout: 5mm wide, walls at 30° from vertical, centered
            // 30mm above the arc center on the front face. Cuts through the
            // front wall like the arc.
            diamond_w  = 10;
            diamond_hw = diamond_w / 2;
            diamond_hh = diamond_hw / tan(30);  // half-height from 30° walls
            diamond_cy = arc_center_y + 20;
            translate([0, diamond_cy, arc_z_lo])
                linear_extrude(height = arc_z_h)
                    polygon([
                        [ diamond_hw,  0],
                        [ 0,  diamond_hh],
                        [-diamond_hw,  0],
                        [ 0, -diamond_hh],
                    ]);

            // Cavity — sharp interior corners so the clicker seats flush.
            // Length is generous so the opening cleanly breaks through the
            // rounded/filleted top.
            cavity_len_cut = pocket_len - wall_bottom + 5;
            translate([-cavity_w/2,
                       pocket_bottom + wall_bottom,
                       cavity_back_z])
                cube([cavity_w, cavity_len_cut, cavity_t]);

            // Trim anything that strays below the plate's back face or below
            // the plate bottom edge — keeps the print flat on the bed.
            translate([0, 0, -50])
                cube([400, 400, 100], center = true);
            translate([0, pocket_bottom - 50, 0])
                cube([400, 100, 400], center = true);
        }

        // Inside-cavity bump on the inside of the front wall, dome pointing
        // into the cavity (-Z). Added outside the difference so the cavity
        // subtraction doesn't remove it.
        bump_z0_in = pocket_back_z + pocket_t - wall_front;
        intersection() {
            translate([0, bump_y, bump_z0_in - bump_h + bump_R])
                sphere(r = bump_R, $fn = 96);
            translate([-bump_d, bump_y - bump_d, bump_z0_in - bump_h])
                cube([bump_d * 2, bump_d * 2, bump_h]);
        }
        }
    }
}

// Pocket shell: fully rounded on all 12 edges, with a perimeter fillet that
// bridges the back edge of the pocket to the plate's front face. Built as
// the hull of (a) a footprint slab on the plate, slightly oversized on the
// non-bed sides so it forms a fillet around the seam, and (b) the inset
// 8-sphere box that defines the rounded pocket itself. The bottom (Y =
// pocket_bottom) is NOT oversized so the printed part stays flat on the bed.
module pocket_outer(pocket_w, pocket_t, pocket_len, pocket_bottom, pocket_back_z, pt) {
    cr  = 2;            // pocket edge radius (front, away from plate)
    crb = 2;            // back edge radius — the four corners against the plate

    // 8 inset spheres = fully rounded pocket box. Back-side spheres (against
    // the plate) use crb; front-side spheres use cr.
    hull() {
        for (x = [-pocket_w/2 + cr, pocket_w/2 - cr])
            for (y = [pocket_bottom + cr, pocket_bottom + pocket_len - cr])
                translate([x, y, pocket_back_z + pocket_t - cr])
                    sphere(r = cr);
        for (x = [-pocket_w/2 + crb, pocket_w/2 - crb])
            for (y = [pocket_bottom + crb, pocket_bottom + pocket_len - crb])
                translate([x, y, pocket_back_z + crb])
                    sphere(r = crb);
    }
}
