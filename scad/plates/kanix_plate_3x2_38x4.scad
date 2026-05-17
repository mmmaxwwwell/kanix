// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Render fixture: Kanix clip — 3x2 grid, 38mm belt height, 4mm belt thickness.
//
// TODO: kanix-plate.scad currently only supports square plates. This fixture
// renders a placeholder mounting_plate (back plate only) until kanix-plate
// is reworked to handle rectangular grids. Switch to kanix_plate_from_presets
// once the rewrite lands.

include <../lib/presets.scad>
use <../lib/mounting-plate.scad>

mounting_plate(kanix_grid_3x2, thickness = 4);
