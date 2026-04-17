# deploy/nixos/supertokens.nix — NixOS module for SuperTokens core
# Configures SuperTokens as a systemd service with PostgreSQL backend.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.kanix.supertokens;

  # Generate config.yaml for SuperTokens core
  configFile = pkgs.writeText "supertokens-config.yaml" ''
    host: ${cfg.host}
    port: ${toString cfg.port}
    postgresql_connection_uri: "postgresql://${cfg.database.host}:${toString cfg.database.port}/${cfg.database.name}"
    ${lib.optionalString (cfg.apiKeys != []) "api_keys: ${lib.concatStringsSep "," cfg.apiKeys}"}
  '';
in
{
  options.services.kanix.supertokens = {
    enable = lib.mkEnableOption "Kanix SuperTokens core";

    package = lib.mkOption {
      type = lib.types.path;
      description = "Path to the SuperTokens core installation directory.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address SuperTokens listens on.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3567;
      description = "Port SuperTokens listens on.";
    };

    apiKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "API keys for authenticating requests to the SuperTokens core. Empty disables key checking.";
    };

    database = {
      host = lib.mkOption {
        type = lib.types.str;
        default = "127.0.0.1";
        description = "PostgreSQL host for SuperTokens.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = config.services.kanix.postgres.port or 5432;
        description = "PostgreSQL port for SuperTokens.";
      };

      name = lib.mkOption {
        type = lib.types.str;
        default = "supertokens";
        description = "PostgreSQL database name for SuperTokens.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # --- SuperTokens core systemd service ---
    systemd.services.kanix-supertokens = {
      description = "SuperTokens core for Kanix authentication";
      after = [ "network.target" "postgresql.service" ];
      requires = [ "postgresql.service" ];
      wantedBy = [ "multi-user.target" ];

      serviceConfig = {
        Type = "simple";
        DynamicUser = true;
        StateDirectory = "kanix-supertokens";
        WorkingDirectory = cfg.package;

        ExecStartPre = pkgs.writeShellScript "kanix-supertokens-config" ''
          cp ${configFile} /var/lib/kanix-supertokens/config.yaml
        '';

        ExecStart = "${pkgs.jdk}/bin/java -classpath 'core/*:plugin-interface/*:plugin/*:ee/*' io.supertokens.Main /var/lib/kanix-supertokens";

        Restart = "on-failure";
        RestartSec = 5;

        # Hardening
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        ReadWritePaths = [ "/var/lib/kanix-supertokens" ];
        ReadOnlyPaths = [ cfg.package ];
      };
    };
  };
}
