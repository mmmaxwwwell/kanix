// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Earth Rated Poo Bag Holder - Kanix Belt Mount
// Holds a roll of poo bags (63mm tall, 32mm diameter).
// Screw-in cap with bowl grip, front slit for dispensing.
// Threads recessed into wall so bags pass through freely.
// Mounts to a Kanix belt clip.

include <BOSL2/std.scad>
include <BOSL2/threading.scad>
include <lib/common.scad>

// ===== Roll Parameters =====
roll_diameter  = 32;      // mm
roll_height    = 63;      // mm
roll_clearance = 0.5;     // mm per side (TPU slop)

// ===== Container Parameters =====
wall           = 3;       // mm
bottom         = 3;       // mm
container_id   = roll_diameter + roll_clearance * 2;  // 33mm
container_od   = container_id + wall * 2;              // 39mm

// ===== Threading (grooves cut into wall only, bore stays at container_id) =====
thread_extra   = 4;       // mm thread depth into wall
thread_section_od = container_od + thread_extra * 2;   // 47mm body width
thread_d       = container_id + thread_extra;           // 37mm
thread_pitch   = 3;       // mm chunky pitch
thread_starts  = 4;       // quad-start: easy to find, 4 entry points
thread_height  = 8;       // mm (lead=6mm with 2 starts, ~1.3 turns to seat)
thread_tol     = 0.2;     // mm radial clearance
thread_crest_d = thread_d - thread_pitch * 1.08;       // ~34.84mm (protects bore from widening)

// Container height: roll + bottom + margin + threads above roll
container_h    = roll_height + bottom + 3 + thread_height; // 77mm

// ===== Cap (flush plug with bowl grip) =====
cap_h          = thread_height - 0.5; // 7.5mm total plug height
cap_thread_l   = cap_h - thread_pitch; // effective thread length after bevel
bowl_depth     = 5;       // mm depth of bowl (fits within cap_h)
bowl_d         = thread_d - 8;  // mm bowl diameter (fits within plug)
grab_width     = bowl_d;      // mm bar length (spans full bowl)
grab_thick     = 2.5;     // mm bar width

// ===== Bag Slit (V-channel with continuous minimum gap) =====
slit_gap       = 0.2;     // mm continuous gap
slit_v_depth   = 4;       // mm how far the V apex pushes sideways into the wall
guide_notch_w  = 6;       // mm width of guide notch at top
guide_notch_h  = 8;       // mm height of guide notch taper

// ===== Kanix Large Mounting =====
kanix_grid_size = 3;
screw_depth     = 15;    // mm

plate_thickness = 4;

plate_width  = kanix_plate_dim(kanix_grid_size);
plate_height = kanix_plate_dim(kanix_grid_size);
plate_y      = container_od / 2 + plate_thickness;

// ===== Part Selection =====
part = "both"; // "body", "cap", or "both"

$fn = 64;

// ===== Modules =====

module plate_shape() {
    hull() {
        for (x = [-plate_width/2 + plate_corner_r, plate_width/2 - plate_corner_r])
            for (y = [-plate_height/2 + plate_corner_r, plate_height/2 - plate_corner_r])
                translate([x, y, 0])
                    cylinder(r = plate_corner_r, h = plate_thickness);
    }
}

// V-slit cutout, V shape when viewed top-down.
// Apex at x=0 centered in the wall on -Y side.
// Two legs, each 0.2mm (slit_gap) wide, radiating from apex.
// Each leg: tall slit from bottom to near top, then widens to guide_notch_w at container_h.
module v_slit() {
    _wall_center = (thread_section_od/2 + container_id/2) / 2;
    _notch_bottom = container_h - guide_notch_h;
    _reach = (thread_section_od/2 + 0.1) / 2;

    translate([0, -_wall_center, 0]) {
        // --- Leg 1 ---
        rotate([0, 0, 45 + 90]) {
            // Slit: constant slit_gap from bottom to notch_bottom
            hull() {
                translate([-slit_gap/2, -_reach, bottom])
                    cube([slit_gap, _reach, 0.01]);
                translate([-slit_gap/2, -_reach, _notch_bottom])
                    cube([slit_gap, _reach, 0.01]);
            }
            // Taper: slit_gap at notch_bottom widens to guide_notch_w at container_h
            hull() {
                translate([-slit_gap/2, -_reach, _notch_bottom])
                    cube([slit_gap, _reach, 0.01]);
                translate([-guide_notch_w/2, -_reach, container_h])
                    cube([guide_notch_w, _reach + guide_notch_w/2, 0.01]);
            }
        }

        // --- Leg 2 ---
        rotate([0, 0, -45 + 90]) {
            // Slit: constant slit_gap from bottom to notch_bottom
            hull() {
                translate([-slit_gap/2, -_reach, bottom])
                    cube([slit_gap, _reach, 0.01]);
                translate([-slit_gap/2, -_reach, _notch_bottom])
                    cube([slit_gap, _reach, 0.01]);
            }
            // Taper: slit_gap at notch_bottom widens to guide_notch_w at container_h
            hull() {
                translate([-slit_gap/2, -_reach, _notch_bottom])
                    cube([slit_gap, _reach, 0.01]);
                translate([-guide_notch_w/2, -_reach, container_h])
                    cube([guide_notch_w, _reach + guide_notch_w/2, 0.01]);
            }
        }
    }
}

module body() {
    difference() {
        // Step 1: body solid with thread grooves cut ONLY into the wall
        difference() {
            hull() {
                cylinder(d = thread_section_od, h = container_h);
                translate([0, plate_y, container_h - plate_height / 2])
                    rotate([90, 0, 0])
                    plate_shape();
            }

            // Thread grooves only in wall (protect bore from widening)
            translate([0, 0, container_h - cap_thread_l])
                difference() {
                    threaded_rod(d = thread_d, l = cap_thread_l,
                                 pitch = thread_pitch, starts = thread_starts,
                                 internal = true, lead_in = 0,
                                 bevel1 = false,
                                 end_len1 = 0, end_len2 = 0,
                                 anchor = BOTTOM, $slop = thread_tol);
                    // Protect: don't let threads widen the bore
                    translate([0, 0, -0.1])
                        cylinder(d = thread_crest_d + 1, h = cap_thread_l + 0.2);
                }
        }

        // Step 2: cut bore, slit, and holes from the threaded body
        // Bore at container_id (below threads)
        translate([0, 0, bottom])
            cylinder(d = container_id, h = container_h - bottom + 1);

        // Taper from container_id bore up to thread bore (no lip)
        translate([0, 0, container_h - cap_thread_l - 1 - (thread_crest_d + 1 - container_id)/2])
            cylinder(d1 = container_id, d2 = thread_crest_d + 1,
                     h = (thread_crest_d + 1 - container_id)/2);
        // Thread bore at thread_crest_d + 1
        translate([0, 0, container_h - cap_thread_l - 1])
            cylinder(d = thread_crest_d + 1, h = cap_thread_l + 1 + 1);

        // V-channel slit cutout
        v_slit();

        // Screw holes - 2x3 grid (skip middle column)
        grid_offset = (kanix_grid_size - 1) / 2;
        for (col = [0, 2])
            for (row = [0 : kanix_grid_size - 1])
                translate([
                    (col - grid_offset) * kanix_hole_spacing,
                    plate_y + 0.1,
                    container_h - plate_height / 2 + (row - grid_offset) * kanix_hole_spacing
                ])
                    rotate([90, 0, 0])
                    cylinder(d = kanix_screw_d, h = screw_depth);
    }
}

// Cap: flush plug with bowl + single bar grip.
// Screws into the threaded section, sits flush with container top.
// Print with bowl face up.
module cap() {
    difference() {
        // Threaded plug with chamfered lead-in on bottom
        threaded_rod(d = thread_d, l = cap_h,
                     pitch = thread_pitch, starts = thread_starts,
                     bevel1 = true, bevel2 = false,
                     anchor = BOTTOM);

        // Bowl depression (keeps bar intact)
        difference() {
            // Concave bowl cut into top face
            translate([0, 0, cap_h])
                resize([bowl_d, bowl_d, bowl_depth * 2])
                sphere(d = bowl_d);

            // Protect the bar from being subtracted
            translate([-grab_width/2, -grab_thick/2, cap_h - bowl_depth - 0.1])
                cube([grab_width, grab_thick, bowl_depth + 1]);
        }
    }
}

// ===== Render =====

if (part == "body" || part == "both")
    body();

if (part == "cap" || part == "both")
    translate([part == "both" ? thread_section_od + 15 : 0,
               part == "both" ? -plate_y : 0, 0])
        cap();
