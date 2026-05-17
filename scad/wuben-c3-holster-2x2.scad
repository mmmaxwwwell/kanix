// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Render fixture: Wuben C3 holster for the 38x4 (2x2) Kanix preset.

include <BOSL2/std.scad>
include <BOSL2/rounding.scad>
include <lib/presets.scad>
use <lib/wuben-c3-holster.scad>

$fn = 64;

wuben_c3_holster(kanix_preset_38x4,
                 plate_t          = 5,
                 tube_offset      = 3,
                 screw_hole_depth = 8);
