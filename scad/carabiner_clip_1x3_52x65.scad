// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Render fixture: 1x3 carabiner clip on the 52x6.5 preset.

include <lib/presets.scad>
use <lib/carabiner-clip.scad>

$fn = 64;

rotate([90,0,0])
carabiner_clip(kanix_preset_52x65,
    hole_rows           = 1,    // 1 = single-row clip, 2 = double-row clip
    hole_cols           = 3,    // columns along the plate's long edge
    outer_disc_diameter = 27,   // outside diameter of the carabiner disc
    outer_disc_height   = 52/3,   // disc thickness (axis = Y, away from plate)
    inner_disc_diameter = 17,   // through-hole the carabiner clips into
    disc_taper          = 1,    // 45° taper depth on each face of the disc
    bore_chamfer        = 1.5,    // 45° chamfer radial depth on each lip of the bore
    bore_chamfer_recess = 0,    // shift chamfer narrow end inward along bore axis (recess below disc face)
    bore_round          = 1,    // round-over on every edge of the bore cut
    screw_length        = 7     // override preset's screw_length (5mm) for this fixture
);
