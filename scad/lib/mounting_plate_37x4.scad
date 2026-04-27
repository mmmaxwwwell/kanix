// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Render fixture: bare mounting plate sized for the 37x4 (2x2) preset.

include <presets.scad>
use <mounting-plate.scad>

$fn = 64;

mounting_plate(kanix_preset_37x4);
