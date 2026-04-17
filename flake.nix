{
  description = "Kanix - modular dog handler belt system and commerce platform";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    scad.url = "path:./scad";
    site.url = "path:./site";
  };

  outputs = { self, nixpkgs, flake-utils, scad, site }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        scadShell = scad.devShells.${system}.default;
        siteShell = site.devShells.${system}.default;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # Node.js / frontend
            nodejs_22
            pnpm

            # Flutter (admin + customer apps)
            flutter

            # Database
            postgresql

            # Migrations
            liquibase

            # Infrastructure
            opentofu
            process-compose

            # Security scanning
            trivy
            semgrep
            gitleaks
          ];

          inputsFrom = [ scadShell siteShell ];
          OPENSCADPATH = "${scad.packages.${system}.bosl2}";
        };
      }
    );
}
