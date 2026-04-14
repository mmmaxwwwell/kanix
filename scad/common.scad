// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Kanix Common Parameters
// Shared constants Kanix belt clip mounting.
// 3x3 grid of holes, 3/4" (19.05mm) spacing, M5 self-tapping screws.

// ===== Kanix Mounting Constants =====
kanix_hole_spacing = 19.05; // mm between adjacent holes (3/4")
kanix_screw_d      = 4.2;   // mm pilot hole for M5 self-tap

// ===== Default Plate Parameters =====
// Override these after include if your design needs different values.
plate_margin   = 7;   // mm margin around outermost holes
plate_corner_r = 4;   // mm corner radius
plate_edge_r   = 2;   // mm top edge rounding radius

// ===== Helper Functions =====

// Plate dimension for a given grid size and margin.
// Returns the width or height of a square plate that fits the hole grid.
function kanix_plate_dim(grid_size, margin = plate_margin) =
    kanix_hole_spacing * (grid_size - 1) + margin * 2;

// Grid offset: centers a grid_size x grid_size pattern around the origin.
function kanix_grid_offset(grid_size) =
    (grid_size - 1) / 2;
