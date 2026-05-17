top_hole_width = 11;
top_hole_length = 5;
pocket_bottom_diameter = 5;
bar_top_to_pocket_bottom = 8.3;
wall_size = 1;
back_hole_height = 4;
back_bar_length = 4;
back_bar_height = 4;
gap = 0.3;
center_cutout_depth = top_hole_length - wall_size * 2 - gap;

module center_cutout(){
    translate([0, 0, wall_size * -2]) 
    rotate([0,90,0])
    hull(){
        translate([bar_top_to_pocket_bottom - center_cutout_depth/2,0,0])
        cylinder(d = center_cutout_depth, h = top_hole_width + 1, $fn=32, center = true);
        translate([-bar_top_to_pocket_bottom + center_cutout_depth/2,0,0])
        cylinder(d = center_cutout_depth, h = top_hole_width + 1, $fn=32, center = true);
    }
}
module locking_tab(){
    rotate([0, 90, 0])
    linear_extrude(height = top_hole_width - gap * 2, center = true)
    polygon(points = [[0, 0], [center_cutout_depth, 0], [0, center_cutout_depth]]);
}
difference(){

    union(){
        difference(){
            cube([top_hole_width - gap*2, top_hole_length, bar_top_to_pocket_bottom * 2], center = true);
            center_cutout();

            //rear wall short cutout
            translate([0,-top_hole_length/2 + wall_size/2,-bar_top_to_pocket_bottom * 1.25])
            cube([top_hole_width - gap*2, wall_size * 2, bar_top_to_pocket_bottom * 2], center = true);
        }

        translate([0,top_hole_length/2,-bar_top_to_pocket_bottom + back_hole_height - gap])
        locking_tab();

        //thicker front to support locking tab strentgh
        translate([0,center_cutout_depth/2,0])
        cube([top_hole_width - gap*2, wall_size, bar_top_to_pocket_bottom * 2], center = true);
    }

    //mounting hole
    translate([0,0,5])
    rotate([0,90,90])
    cylinder(d = 4, h = top_hole_length * 4, center = true, $fn = 32);

    //front bar under-latch cutout
    translate([0,top_hole_length/2 - wall_size,-bar_top_to_pocket_bottom * 2 + 1 ])
    cube([top_hole_width - gap*2, wall_size * 2, bar_top_to_pocket_bottom * 2], center = true);
}
//locking block to prevent twist out
translate([0,back_bar_length/2 +  top_hole_length/2,-bar_top_to_pocket_bottom + back_hole_height - gap*2 + back_bar_height/2 + back_bar_height])
cube([top_hole_width - gap * 2, back_bar_length, back_bar_length], center = true);
