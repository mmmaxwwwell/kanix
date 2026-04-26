// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Hinge Module
// ============
// Creates a segmented hinge leaf for interlocking hinge pairs.
//
// Origin is at the center of the barrel circle.
// The arm extends from the barrel.
//
// Parameters:
//   length     - total hinge length along the barrel axis (Z)
//   outer_diam - barrel outer diameter
//   segments   - number of segments to split the length into
//   inner      - if true, fills even segments (0,2,4...); if false, odd (1,3,5...)
//   gap        - total gap between mating segments (each segment side insets by gap/2,
//                except the outer edges of end segments)
//   cutout     - if true, renders only the negative volume for mounting block integration
//   fn         - facet count for circles (default: 64)

module hinge2(
    length,
    outer_diam,
    segments = 1,
    inner = true,
    gap = 0.2,
    cutout = false,
    latch = false,
    fn = 64
) {
    r = outer_diam / 2;

    // Block-side arm: reaches to block surface
    seg_width = length / segments;
    tip_r = 0.5;
    cone_scale = latch ? 0.5 : 1;

    module cone_pin(h) {
        sh = h * cone_scale;
        translate([0,0,sh/2])
        cylinder(h = sh, r1 = sh, r2 = tip_r, $fn = 32, center = true);
    }

    module barrel_segment(seg_len, inner) {
        translate([0,-outer_diam/2,seg_len/2])
        cube([outer_diam,outer_diam ,seg_len], center = true);
        linear_extrude(height = seg_len, convexity = 4)
        circle(d = outer_diam, $fn = fn);
        
    }

    module segment_cutouts() {
        for (i = [0 : segments - 1]) {
            fill = inner ? (i % 2 == 1) : (i % 2 == 0);
            if (fill) {
                raw_start = i * seg_width - length / 2 - gap/2;
                translate([0, 0, raw_start])
                linear_extrude(height = seg_width + gap, convexity = 4)
                translate([0, -gap/2]) {
                    circle(d = outer_diam + gap, $fn = fn);
                    //support here
                }
            }
        }
    }

    module cone_indents() {
        for (i = [0 : segments - 1]) {
            fill = inner ? (i % 2 == 0) : (i % 2 == 1);
            if (fill) {
                raw_start = i * seg_width - length / 2;
                raw_end = (i + 1) * seg_width - length / 2;
                start = (i == 0) ? raw_start : raw_start + gap / 2;
                end = (i == segments - 1) ? raw_end : raw_end - gap / 2;
                seg_len = end - start;
                cone_h = seg_len / 3;

                if (i > 0)
                    translate([0, -gap/2, start - 0.01])
                    cone_pin(cone_h);
                if (i < segments - 1)
                    translate([0, -gap/2, end + 0.01])
                    mirror([0, 0, 1])
                    cone_pin(cone_h);
            }
        }
    }

    module cone_protrusions() {
        for (i = [0 : segments - 1]) {
            fill = inner ? (i % 2 == 0) : (i % 2 == 1);
            if (fill) {
                raw_start = i * seg_width - length / 2;
                raw_end = (i + 1) * seg_width - length / 2;
                start = (i == 0) ? raw_start : raw_start + gap / 2;
                end = (i == segments - 1) ? raw_end : raw_end - gap / 2;
                seg_len = end - start;
                cone_h = seg_len / 3;

                if (i > 0)
                    translate([0, -gap/2, start + 0.01])
                    mirror([0, 0, 1])
                    cone_pin(cone_h);
                if (i < segments - 1)
                    translate([0, -gap/2, end - 0.01])
                    cone_pin(cone_h);
            }
        }
    }

    module barrel_segments() {
        for (i = [0 : segments - 1]) {
            fill = inner ? (i % 2 == 0) : (i % 2 == 1);
            if (fill) {
                raw_start = i * seg_width - length / 2;
                raw_end = (i + 1) * seg_width - length / 2;
                start = (i == 0) ? raw_start : raw_start + gap / 2;
                end = (i == segments - 1) ? raw_end : raw_end - gap / 2;
                seg_len = end - start;

                translate([0, 0, start])
                barrel_segment(seg_len, inner);
            }
        }
    }

    if(cutout){
        if (inner)
            cone_indents();
    }else{
        difference() {
            barrel_segments();
            segment_cutouts();
            if (inner)
                translate([0,gap/2,0])
                cone_indents();
        }
        if (!inner)
            translate([0,gap/2,0])
            cone_protrusions();
    }
}
