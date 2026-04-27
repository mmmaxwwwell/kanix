// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.

use <lib/kanix-plate.scad>

kanix_plate(
    belt_height = 51,
    belt_thickness = 4,
    plate_size = 37,
    plate_thickness = 4,
    bolt_hole_d = 5.5,
    counterbore_d = 11.5,
    view = "open",
    hole_cols = 2,
    hole_rows = 2,
    main_hinge_segments = 5,
    latch_hinge_segments = 5,
    middle_clip_hinge_segments = 5
);
