// Copyright (c) 2026 mmmaxwwwell
// Licensed under CC BY-NC-ND 4.0, https://creativecommons.org/licenses/by-nc-nd/4.0/
// Free for personal use. Commercial use requires a separate license.
//
// Kanix Belt Presets
//
// A preset is a vector-of-pairs ("struct") describing the mounting interface
// for a Kanix belt clip. Accessories take a preset and pull every
// belt-and-bolt-pattern dimension from it, so the holster's bolt grid is
// guaranteed to align with the clip it mounts to.
//
// To add a preset: copy a block, change the values, give it a unique name.

include <common.scad>

// ----- 37mm plate, 4mm belt (2x2 hole grid) -----
kanix_preset_37x4 = [
    ["name",          "37x4"],
    ["plate_size",    37],     // mm, square plate edge length
    ["plate_thickness", 4],    // mm
    ["belt_thickness", 4],     // mm (clip-only; accessories ignore)
    ["belt_height",   51],     // mm (2" duty belt; clip-only)
    ["hole_cols",     2],
    ["hole_rows",     2],
    ["hole_spacing",  kanix_hole_spacing],
    ["pilot_hole_d",  kanix_screw_d],   // M5 self-tap pilot — threads bite into plastic
    ["screw_length",  3]                // plate_thickness - 1mm: max screw bite without poking through
];

// ----- 52mm plate, 6.5mm belt (3x3 hole grid) -----
kanix_preset_52x65 = [
    ["name",          "52x6_5"],
    ["plate_size",    52],
    ["plate_thickness", 5.5],
    ["belt_thickness", 6.5],
    ["belt_height",   51],
    ["hole_cols",     3],
    ["hole_rows",     3],
    ["hole_spacing",  kanix_hole_spacing],
    ["pilot_hole_d",  kanix_screw_d],
    ["screw_length",  5]                // 5mm screw bite, 0.5mm cap above
];

// ----- Accessor -----
// Look up a field by key. Errors loudly (undef) if the key is absent so a
// typo surfaces immediately instead of silently using a default.
function preset_get(preset, key) =
    let (hits = [for (kv = preset) if (kv[0] == key) kv[1]])
    hits[0];
