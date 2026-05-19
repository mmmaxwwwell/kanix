// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
//
// Belt-loop punch jig — 9" piece of 24.8mm BioThane.
// 4-hole squares flush with both strap ends, and 2-hole rows at 2.5" / 4.5"
// from the top end.

include <lib/leash-jig.scad>

$fn = 64;

strap_len = 9 * inch;                            // 228.6 mm

leash_jig(
    length  = strap_len,
    hole_ys = [
        // bottom-end square (two rows, hole_pitch apart)
        edge_to_center,                          //   6.6
        edge_to_center + hole_pitch,             //  18.2
        // pair at 4.5" from top
        strap_len - 4.5 * inch,                  // 114.3
        // pair at 2.5" from top
        strap_len - 2.5 * inch,                  // 165.1
        // top-end square
        strap_len - edge_to_center - hole_pitch, // 210.4
        strap_len - edge_to_center,              // 222.0
    ]
);
