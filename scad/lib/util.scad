module sphere_cube(length, width, height, r) {
    eps = 0.001;
    rc = min(r, length/2 - eps, width/2 - eps, height/2 - eps);
    minkowski() {
        cube([length - 2*rc, width - 2*rc, height - 2*rc], center=true);
        sphere(r=rc);
    }
}
