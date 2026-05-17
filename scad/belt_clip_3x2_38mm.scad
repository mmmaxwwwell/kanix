// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.

include <lib/presets.scad>
use <lib/belt-clip.scad>

$fn = 64;

// 3 cols (along belt) × 2 rows: rectangular plate, 4mm thick.
// plate_w = 19.05*2 + 14 ≈ 52.1, plate_h = 19.05 + 14 ≈ 33.05.
belt_clip(kanix_preset_38x4,
          belt_width      = 38,
          belt_thickness  = 4,
          plate_thickness = 4,
          plate_w         = 52,
          plate_h         = 33,
          hole_cols       = 3,
          hole_rows       = 2);
