{
  description = "Kanix OpenSCAD models with BOSL2 library";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    bosl2 = {
      url = "github:BelfrySCAD/BOSL2";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, bosl2 }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        bosl2-lib = pkgs.stdenvNoCC.mkDerivation {
          pname = "BOSL2";
          version = "unstable";
          src = bosl2;
          installPhase = ''
            mkdir -p $out/BOSL2
            cp -r *.scad $out/BOSL2/
          '';
        };
      in
      {
        packages.bosl2 = bosl2-lib;

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.openscad-unstable ];
          OPENSCADPATH = "${bosl2-lib}";
        };
      }
    );
}
