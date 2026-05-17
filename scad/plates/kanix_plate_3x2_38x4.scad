// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Render fixture: Kanix clip — 3x2 grid, 38mm belt height, 4mm belt thickness.

include <../lib/presets.scad>
use <../lib/kanix-plate.scad>

kanix_plate_from_presets(kanix_grid_3x2, kanix_belt_38x4);
