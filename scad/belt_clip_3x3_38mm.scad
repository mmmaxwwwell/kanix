// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.

include <lib/presets.scad>
use <lib/belt-clip.scad>

$fn = 64;

belt_clip(kanix_preset_52x65,
          belt_width      = 38,
          belt_thickness  = 4,
          plate_thickness = 4);
