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
    screw_length         = undef, // override preset's screw_length for this accessory
    disc_z_override      = undef // override disc center Z (controls bore-bottom height vs plate)
) {
    assert(outer_disc_height > 2 * disc_taper,
        "outer_disc_height must exceed 2 * disc_taper for a flat middle band");

    plate_t_base = preset_get(preset, "plate_thickness");
    screw_l = screw_length == undef ? preset_get(preset, "screw_length") : screw_length;
    // Grow the plate so the screw bore stays blind with ≥1mm of cap.
    plate_t = max(plate_t_base, screw_l + 1);

    // Disc center sits so the bore's bottom edge clears the screw tip by
    // 1 mm. Screw tip is at Z = screw_length (screws driven up from Z=0
    // through the plate bottom). Bore bottom in world Z is
    // disc_z - inner_disc_diameter/2, so:
    //   disc_z = screw_length + 1 + inner_disc_diameter/2
    // Clamp to plate_t + bore_radius so the bore never dips into the plate
    // top when the screw is short.
    // Disc thickness axis is Y. Place the disc so its front face (toward -Y)
    // sits flush with the plate's bottom edge (Y = -plate_h/2). Plate's Y
    // span is plate_size * hole_rows / preset.hole_rows.
    plate_size_p = preset_get(preset, "plate_size");
    full_rows    = preset_get(preset, "hole_rows");
    plate_h      = plate_size_p * hole_rows / full_rows;
    disc_y       = -plate_h / 2 + outer_disc_height / 2;
    disc_z_auto  = max(plate_t + inner_disc_diameter / 2,
                       screw_l + 1 + inner_disc_diameter / 2);
    disc_z       = disc_z_override == undef ? disc_z_auto : disc_z_override;

    // Slope geometry: top of disc → top-front edge of mounting plate.
    top_disc_z   = disc_z + outer_disc_diameter / 2;
    top_plate_z  = plate_t;
    top_disc_y   = disc_y;
    top_plate_y  = plate_h / 2;
    run_y        = top_plate_y - top_disc_y;
    rise_z       = top_disc_z  - top_plate_z;
    slope_angle  = atan2(rise_z, run_y);  // from +Y horizontal
    n_y = sin(slope_angle);
    n_z = cos(slope_angle);
    bore_r = inner_disc_diameter / 2;

    difference() {
        // Hull the outer disc to the entire mounting plate.
        hull() {
            mounting_plate(preset,
                           thickness   = plate_t,
                           hole_rows   = hole_rows,
                           hole_cols   = hole_cols,
                           drill_holes = false);
            translate([0, disc_y, disc_z])
                rotate([90, 0, 0])
                    tapered_disc(d = outer_disc_diameter,
                                 h = outer_disc_height,
                                 taper = disc_taper);
        }
        // Re-cut the bolt grid into the hulled body. Blind holes —
        // `screw_l` deep with ≥1mm of cap (plate_t was grown above to
        // guarantee this).
        plate_holes(preset, screw_l, hole_cols, hole_rows);
        // Carabiner through-hole. Minkowski with a sphere rounds every
        // edge of this cut. Shrink the cylinder by bore_round first so
        // the final hole size still matches inner_disc_diameter.
        plate_sz = preset_get(preset, "plate_size");
        bore_len = plate_sz * 2;
        translate([0, 0, disc_z])
            rotate([90, 0, 0])
                minkowski() {
                    cylinder(d = inner_disc_diameter - 2 * bore_round,
                             h = bore_len - 2 * bore_round,
                             center = true,
                             $fn = 48);
                    sphere(r = bore_round, $fn = 16);
                }
        // Front-face (−Y) bore chamfer only. 60° from horizontal so the
        // bottom arc is a self-supporting overhang for FDM.
        chamfer_axial = bore_chamfer * tan(60);
        if (bore_chamfer > 0)
            translate([0,
                       disc_y - (outer_disc_height / 2 - bore_chamfer_recess - chamfer_axial),
                       disc_z])
                rotate([90, 0, 0])
                    cylinder(h  = chamfer_axial,
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
