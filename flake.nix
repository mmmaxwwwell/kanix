{
  description = "Kanix - modular dog handler belt system and commerce platform";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # Node.js / frontend
            nodejs_22
            pnpm

            # Flutter (admin + customer apps)
            flutter

            # OpenSCAD (3D models)
            openscad-unstable

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
        };
      }
    );
}
