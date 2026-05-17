// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Wuben C3 Flashlight Holster - Kanix Belt Mount
// Holds a Wuben C3 flashlight (121.5mm long, 26.5mm body diameter).
// Mounts to any Kanix belt clip via a preset.

include <BOSL2/std.scad>
include <BOSL2/rounding.scad>
include <common.scad>
include <presets.scad>
use <mounting-plate.scad>

// Render the holster for the given Kanix preset.
//
// preset       — kanix_preset_* bundle from lib/presets.scad
// plate_t      — override plate thickness (default: 8mm; thicker than preset
//                so the bolt grid sits in solid plastic behind the tube)
// tube_length  — absolute tube length along Y (mm). Independent of plate
//                size so a 2x2 fixture has the same tube as a 3x3.
// tube_offset  — Z gap between the plate back face (Z=0) and the tube's
//                outer surface (mm). 0 = tube touches plate back.
// screw_hole_depth — override blind bolt-hole depth (mm). Defaults to the
//                preset's screw_length. Bumped up when the plate is thicker
//                than the preset baseline and you want longer screw bite.
//
// Tube position: top of tube is anchored to the top edge of the plate, so
// the tube hangs entirely below the plate's top edge regardless of plate
// size (a 2x2 plate's tube starts lower in absolute Y than a 3x3's).
module wuben_c3_holster(preset,
                        plate_t          = 8,
                        tube_length      = 74,
                        tube_offset      = 1,
                        screw_hole_depth = undef) {
    // ===== Flashlight =====
    light_d    = 26.5;            // Wuben C3 body diameter
    wall       = 3;               // holster wall thickness
    holster_od = light_d + wall * 2;

    // ===== Plate dims from preset =====
    plate_size = preset_get(preset, "plate_size");
    cols       = preset_get(preset, "hole_cols");
    rows       = preset_get(preset, "hole_rows");
    spacing    = preset_get(preset, "hole_spacing");
    pilot_d    = preset_get(preset, "pilot_hole_d");

    plate_width  = plate_size;
    plate_height = plate_size;
    row_offset   = (rows - 1) / 2;
    col_offset   = (cols - 1) / 2;

    // ===== Holster geometry =====
    // Tube axis along Y, flashlight hangs down. Length is absolute (not
    // plate-derived); the top of the tube is pinned to the top edge of
    // the plate, so the bottom is simply length below that.
    holster_length   = tube_length;
    holster_top_y    = plate_height / 2;
    holster_bottom_y = holster_top_y - holster_length;

    // Tube center in Z: outer surface sits `tube_offset` away from plate back.
    holster_z = tube_offset + holster_od / 2;

    // ===== Flex cutout =====
    // Front cutout so holster can flex open for insertion. Solid below
    // cutout_bottom_y to retain the flashlight tip.
    cutout_width    = 8;
    cutout_bottom_y = holster_bottom_y + 32;

    // Rotate the whole model so the tube's closed end (originally at -Y)
    // points down (-Z). Plate back, originally on Z=0, now lies on the XZ
    // plane facing -Y. Children below are authored in the original frame.
    rotate([90, 0, 0])
    union() {
    difference() {
        // Hull plate body + tube into a single fillet-fairing shell. This
        // smooths the plate-to-tube transition instead of leaving a hard
        // step where the cylinder meets the plate. The hull preserves the
        // flat plate back (Z=0) since both inputs sit at or above Z=0.
        hull() {
            // drill_holes=false means we drill our own bolt grid below
            // (with the holster-specific screw_hole_depth). screw_hole_depth=0
            // here just keeps mounting_plate's internal assert satisfied
            // when plate_t equals the preset's screw_length.
            mounting_plate(preset,
                           thickness        = plate_t,
                           drill_holes      = false,
                           screw_hole_depth = 0);
            holster_tube(holster_bottom_y, holster_z, holster_od,
                         holster_length);
        }

        // Flashlight bore (closed bottom, open top, flared opening).
        translate([0, holster_bottom_y + wall, holster_z])
            rotate([-90, 0, 0])
                cyl(d = light_d, l = holster_length - wall + 0.1,
                    chamfer2 = -1, anchor = BOTTOM);

        // Bolt grid: blind shaft holes drilled from the bottom face. Depth
        // from the preset's screw_length (overridable) so they don't punch
        // through the top of the (overridden-thickness) plate. For
        // odd-column grids, skip the middle column (the holster body sits
        // in front of it, so a screw there has nowhere to bite).
        // Holes can be deeper than plate_t — the hull with the tube fills
        // material above the plate's nominal thickness for the screw to
        // bite into. Depth is bounded only by where the bore starts.
        screw_len   = screw_hole_depth == undef
                      ? preset_get(preset, "screw_length")
                      : screw_hole_depth;
        skip_middle = (cols % 2 == 1);
        mid_col     = (cols - 1) / 2;
        for (col = [0 : cols - 1])
            if (!(skip_middle && col == mid_col))
                for (row = [0 : rows - 1])
                    translate([
                        (col - col_offset) * spacing,
                        (row - row_offset) * spacing,
                        -0.1
                    ])
                        cylinder(d = pilot_d, h = screw_len + 0.1, $fn = 32);

        // Front flex cutout - U-shape with chamfered edges.
        cutout_len     = holster_top_y - cutout_bottom_y + 0.1;
        cutout_r       = cutout_width / 2;
        cutout_chamfer = 1;
        n_arc          = 16;
        slot_path = concat(
            [[ cutout_r, 0],
             [ cutout_r, cutout_len - cutout_r],
             [-cutout_r, cutout_len - cutout_r],
             [-cutout_r, 0]],
            [for (i = [1:n_arc-1])
                let(a = 180 + i * 180 / n_arc)
                [cutout_r * cos(a), cutout_r * sin(a)]
            ]
        );
        translate([0, cutout_bottom_y + cutout_r, holster_z])
            offset_sweep(slot_path, height = holster_od,
                top    = os_chamfer(width = cutout_chamfer),
                bottom = os_chamfer(width = cutout_chamfer),
                steps  = 16);

        // Cut anything below plate back (Z=0) flat.
        translate([0, 0, -holster_od])
            cube([holster_od + 1, holster_length * 3, holster_od * 2],
                 center = true);
    }

    // Retention bumps - 4 hulled sphere pairs in bottom 20mm of bore.
    // Bump center sits 1/4 of the bump diameter outside the bore wall, so
    // 3/4 of the bump is buried in material and 1/4 protrudes into the bore.
    bump_d        = 1.5;
    bump_r_offset = light_d / 2 + bump_d / 4;
    for (a = [0, 90, 180, 270])
        translate([0, holster_bottom_y + wall, holster_z])
            rotate([-90, 0, 0])
                translate([bump_r_offset * cos(a),
                           bump_r_offset * sin(a), 0])
                    hull() {
                        translate([0, 0, bump_d / 2])
                            sphere(d = bump_d, $fn = 16);
                        translate([0, 0, 20 - bump_d / 2])
                            sphere(d = bump_d, $fn = 16);
                    }
    } // union (rotated)
}

// Holster tube body with 1mm rounded outside edges at top and bottom.
// The cross-section is a rounded rectangle on one side of the rotation
// axis (revolved around Y to make the tube). Using an explicit polygon
// avoids BOSL2's attachable square() overriding bare square() calls.
module holster_tube(bottom_y, z, od, length) {
    edge_r = 1;
    n_arc  = 16;
    r_out  = od / 2;
    // Path: bottom-left -> top-left -> top-right (arc) -> bottom-right (arc).
    top_arc = [for (i = [0:n_arc])
                let(a = 90 - i * 90 / n_arc)
                [(r_out - edge_r) + edge_r * cos(a),
                 (length - edge_r) + edge_r * sin(a)]];
    bot_arc = [for (i = [0:n_arc])
                let(a = -i * 90 / n_arc)
                [(r_out - edge_r) + edge_r * cos(a),
                 edge_r + edge_r * sin(a)]];
    path = concat([[0, 0], [0, length]], top_arc, bot_arc);
    translate([0, bottom_y, z])
        rotate([-90, 0, 0])
            rotate_extrude()
                polygon(path);
}
