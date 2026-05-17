// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Render fixture: Kanix clip — 4x3 grid, 52mm belt height, 6.5mm belt thickness.
//
// TODO: kanix-plate.scad currently only supports square plates. Placeholder
// renders the back plate only. Switch to kanix_plate_from_presets after the
// rectangular-plate rewrite.

include <../lib/presets.scad>
use <../lib/mounting-plate.scad>

mounting_plate(kanix_grid_4x3, thickness = 5.5);
