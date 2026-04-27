// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Render fixture: bare mounting plate sized for the 52x6.5 preset.
// Defaults to the preset's 3x3 hole grid; override hole_rows/hole_cols
// for variants like the 1x3 carabiner clip plate.

include <presets.scad>
use <mounting-plate.scad>

$fn = 64;

hole_rows = 3;
hole_cols = 3;

mounting_plate(kanix_preset_52x65, hole_rows = hole_rows, hole_cols = hole_cols);
