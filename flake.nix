{
  description = "Kanix - modular dog handler belt system and commerce platform";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-mcp-debugkit.url = "github:mmmaxwwwell/nix-mcp-debugkit";
    scad.url = "path:./scad";
    site.url = "path:./site";
    api.url = "path:./api";
    admin.url = "path:./admin";
    customer.url = "path:./customer";
    deploy.url = "path:./deploy";
  };

  outputs = { self, nixpkgs, flake-utils, nix-mcp-debugkit, scad, site, api, admin, customer, deploy }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        scadShell = scad.devShells.${system}.default;
        siteShell = site.devShells.${system}.default;
        apiShell = api.devShells.${system}.default;
        adminShell = admin.devShells.${system}.default;
        customerShell = customer.devShells.${system}.default;
        deployShell = deploy.devShells.${system}.default;

        mcp-android = nix-mcp-debugkit.packages.${system}.mcp-android;
        mcp-browser = nix-mcp-debugkit.packages.${system}.mcp-browser;

        mcp-android-config = pkgs.writeTextFile {
          name = "mcp-android-config";
          destination = "/mcp/android.json";
          text = builtins.toJSON {
            mcpServers.mcp-android = {
              command = "${mcp-android}/bin/mcp-android";
              args = [];
            };
          };
        };

        mcp-browser-config = pkgs.writeTextFile {
          name = "mcp-browser-config";
          destination = "/mcp/browser.json";
          text = builtins.toJSON {
            mcpServers.mcp-browser = {
              command = "${mcp-browser}/bin/mcp-browser";
              args = [];
            };
          };
        };
      in
      {
        packages = {
          inherit mcp-android mcp-browser mcp-android-config mcp-browser-config;
        };

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
            postgresql_jdbc

            # Infrastructure
            opentofu
            process-compose

            # Security scanning
            trivy
            semgrep
            gitleaks
          ];

          inputsFrom = [ scadShell siteShell apiShell adminShell customerShell deployShell ];
          OPENSCADPATH = "${scad.packages.${system}.bosl2}";
          LIQUIBASE_CLASSPATH = "${pkgs.postgresql_jdbc}/share/java/postgresql-jdbc.jar";
        };
      }
    );
}
