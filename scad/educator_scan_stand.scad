$fn = 128;

difference() {
    union() {
        cylinder(h = 1, d = 60);
        cylinder(h = 25, d = 15);
    }
    translate([0, 0, 25 - 24.5])
        cylinder(h = 24.5 + 0.01, d = 13);
}
