// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Kanix Carabiner Clip
//
// A mounting plate (1x3 or 2x3) with a disc-shaped carabiner attachment
// hulled onto its long edge. The disc is bored through the middle to leave
// a ring; the hull from the disc back to the plate forms a triangular
// gusset, giving the classic "ring on a tab" shape for clipping a
// carabiner. The plate's bottom face sits flat on the print bed.

include <common.scad>
include <presets.scad>
use <mounting-plate.scad>

module carabiner_clip(
    preset,
    hole_rows            = 1,    // 1 = single-row clip, 2 = double-row clip
    hole_cols            = 3,    // columns along the plate's long edge
    outer_disc_diameter  = 22,   // outside diameter of the carabiner disc
    outer_disc_height    = 12,   // disc thickness (axis = Y, away from plate)
    inner_disc_diameter  = 12,   // through-hole the carabiner clips into
    disc_taper           = 5,    // 45° taper depth on each face of the disc
    bore_chamfer         = 1.5,  // 45° chamfer radial depth on each lip of the bore
    bore_chamfer_recess  = 0,    // shift chamfer narrow end inward along bore axis (recess below disc face)
    bore_round           = 1,    // round-over on every edge of the bore cut
    screw_length         = undef // override preset's screw_length for this accessory
) {
    assert(outer_disc_height > 2 * disc_taper,
        "outer_disc_height must exceed 2 * disc_taper for a flat middle band");

    plate_t = preset_get(preset, "plate_thickness");
    screw_l = screw_length == undef ? preset_get(preset, "screw_length") : screw_length;

    // Disc center sits so the bore's bottom edge clears the screw tip by
    // 1 mm. Screw tip is at Z = screw_length (screws driven up from Z=0
    // through the plate bottom). Bore bottom in world Z is
    // disc_z - inner_disc_diameter/2, so:
    //   disc_z = screw_length + 1 + inner_disc_diameter/2
    // Clamp to plate_t + bore_radius so the bore never dips into the plate
    // top when the screw is short.
    disc_y = 0;
    disc_z = max(plate_t + inner_disc_diameter / 2,
                 screw_l + 1 + inner_disc_diameter / 2);

    difference() {
        // Hull the outer disc to the entire mounting plate.
        hull() {
            mounting_plate(preset,
                           hole_rows  = hole_rows,
                           hole_cols  = hole_cols,
                           drill_holes = false);
            translate([0, disc_y, disc_z])
                rotate([90, 0, 0])
                    tapered_disc(d = outer_disc_diameter,
                                 h = outer_disc_height,
                                 taper = disc_taper);
        }
        // Re-cut the bolt grid using the plate module's own cutout mode,
        // so spacing/offsets/diameter stay in lockstep with the plate.
        // Hole cylinders go through the full plate thickness.
        mounting_plate(preset,
                       hole_rows = hole_rows,
                       hole_cols = hole_cols,
                       cutout    = true);
        // Carabiner through-hole. Cut all the way through the gusset along
        // Y (not just the disc thickness) so the bore actually opens to
        // the air on both faces of the pyramid. Minkowski with a sphere
        // rounds every edge of this cut (including the sharp corner where
        // the bore exits the plate's top face). The cylinder is shrunk by
        // bore_round first so the final hole size still matches
        // inner_disc_diameter after the sphere inflates it back.
        plate_sz = preset_get(preset, "plate_size");
        bore_len = plate_sz * 2;   // generous overshoot, trimmed by the hull
        translate([0, 0, disc_z])
            rotate([90, 0, 0])
                minkowski() {
                    cylinder(d = inner_disc_diameter - 2 * bore_round,
                             h = bore_len - 2 * bore_round,
                             center = true,
                             $fn = 48);
                    sphere(r = bore_round, $fn = 16);
                }
        // 45° chamfer cone at each mouth of the bore. Coaxial with the
        // bore (axis along Y). Axial length = radial depth = bore_chamfer
        // (true 45°). `bore_chamfer_recess` slides the whole chamfer cone
        // INWARD along the bore so its wide end sits that far below the
        // disc face — useful for keeping a flat disc face while still
        // breaking the inner edge of the bore.
        bore_r = inner_disc_diameter / 2;
        if (bore_chamfer > 0)
            for (side = [-1, 1])
                // Wide end (r2) lands at y = side * (disc_h/2 - recess).
                // Cylinder is built from narrow end at z=0 to wide end at
                // z=h; rotate maps +Z -> +/-Y depending on side. Place the
                // cylinder origin so the wide end ends up at the recessed
                // disc face position.
                translate([0,
                           side * (outer_disc_height / 2 - bore_chamfer_recess - bore_chamfer),
                           disc_z])
                    rotate([side > 0 ? -90 : 90, 0, 0])
                        cylinder(h  = bore_chamfer,
                                 r1 = bore_r - 0.01,
                                 r2 = bore_r + bore_chamfer,
                                 $fn = 64);
    }
}

// Disc of diameter d and height h along Z, with a 45° taper of depth
// `taper` cut from each circular face. Outer diameter narrows from d in
// the middle to (d - 2*taper) at each end face. Centered on origin.
module tapered_disc(d, h, taper) {
    r = d / 2;
    translate([0, 0, -h/2])
        rotate_extrude($fn = 64)
            polygon(points = [
                [0,         0],
                [r - taper, 0],
                [r,         taper],
                [r,         h - taper],
                [r - taper, h],
                [0,         h]
            ]);
}
