// $fn=32;

use <lib/util.scad>

module cutout_primitives(){
    //two back cylinders
    translate([-14,0,0])
    cylinder(d = 10, h = 62, center = true);
    translate([14,0,0])
    cylinder(d = 10, h = 62, center = true);

    //center body cube
    translate([0,-12,3])
    sphere_cube(length=48.3, width=18, height=68, r=5);

    //lower bottom cube
    translate([0,-10,-34])
    sphere_cube(length=30, width=20, height=16, r=5);

}

hull()
cutout_primitives();