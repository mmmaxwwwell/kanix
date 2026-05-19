// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
//
// 2-foot leash, carabiner end. Same as the cobra end but second square's
// inner edge is 3" from the strap end (one inch less than the cobra end).

include <lib/leash-jig.scad>

$fn = 64;

inner_edge_in = 3;
inner_edge = inner_edge_in * inch;                       // 76.2

end_y0 = edge_to_center;                                 //   6.6
end_y1 = edge_to_center + hole_pitch;                    //  18.2
sec_y0 = inner_edge + edge_to_center;                    //  82.8
sec_y1 = inner_edge + edge_to_center + hole_pitch;       //  94.4

jig_len = sec_y1 + edge_to_center;                       // 101.0

leash_jig(
    length  = jig_len,
    hole_ys = [end_y0, end_y1, sec_y0, sec_y1]
);
