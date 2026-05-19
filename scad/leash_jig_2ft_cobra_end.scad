// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
//
// 2-foot leash, cobra-buckle end. Two 4-hole squares:
//   - end square flush with the strap end
//   - second square with its inner edge 4" from the end

include <lib/leash-jig.scad>

$fn = 64;

inner_edge_in = 4;
inner_edge = inner_edge_in * inch;                       // 101.6

// End square hole Ys
end_y0 = edge_to_center;                                 //   6.6
end_y1 = edge_to_center + hole_pitch;                    //  18.2

// Second square: first row at inner_edge + edge_to_center; second row + pitch
sec_y0 = inner_edge + edge_to_center;                    // 108.2
sec_y1 = inner_edge + edge_to_center + hole_pitch;       // 119.8

jig_len = sec_y1 + edge_to_center;                       // 126.4

leash_jig(
    length  = jig_len,
    hole_ys = [end_y0, end_y1, sec_y0, sec_y1]
);
