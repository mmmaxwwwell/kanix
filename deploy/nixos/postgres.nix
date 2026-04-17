# deploy/nixos/postgres.nix — NixOS module for PostgreSQL 16
# Configures authentication, logging, and backup for the Kanix platform.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.kanix.postgres;
in
{
  options.services.kanix.postgres = {
    enable = lib.mkEnableOption "Kanix PostgreSQL 16 configuration";

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/postgresql/16";
      description = "PostgreSQL data directory.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 5432;
      description = "Port PostgreSQL listens on.";
    };

    backupDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/backup/postgresql";
      description = "Directory for pg_dump backup files.";
    };

    backupSchedule = lib.mkOption {
      type = lib.types.str;
      default = "*-*-* 03:00:00";
      description = "systemd calendar expression for daily backups.";
    };

    backupRetentionDays = lib.mkOption {
      type = lib.types.int;
      default = 14;
      description = "Number of days to retain backup files.";
    };
  };

  config = lib.mkIf cfg.enable {
    # --- PostgreSQL 16 service ---
    services.postgresql = {
      enable = true;
      package = pkgs.postgresql_16;
      dataDir = cfg.dataDir;
      port = cfg.port;

      # --- Authentication (pg_hba.conf) ---
      authentication = lib.mkForce ''
        # TYPE  DATABASE  USER       ADDRESS        METHOD
        local   all       postgres                  peer
        local   all       all                       scram-sha-256
        host    all       all        127.0.0.1/32   scram-sha-256
        host    all       all        ::1/128        scram-sha-256
      '';

      # --- Server settings ---
      settings = {
        # Logging
        log_destination = "stderr";
        logging_collector = true;
        log_directory = "pg_log";
        log_filename = "postgresql-%Y-%m-%d.log";
        log_rotation_age = "1d";
        log_rotation_size = 0; # rely on time-based rotation only
        log_min_duration_statement = 500; # log queries slower than 500ms
        log_line_prefix = "%m [%p] %u@%d ";
        log_statement = "ddl"; # log DDL statements
        log_connections = true;
        log_disconnections = true;

        # Connection tuning
        max_connections = 100;
        shared_buffers = "256MB";
        work_mem = "8MB";
        maintenance_work_mem = "128MB";
        effective_cache_size = "768MB";

        # Security
        password_encryption = "scram-sha-256";
        ssl = false; # TLS termination handled by reverse proxy
      };

      # --- Ensure kanix database and role exist ---
      ensureDatabases = [ "kanix" "supertokens" ];
      ensureUsers = [
        {
          name = "kanix";
          ensureDBOwnership = true;
        }
      ];
    };

    # --- Daily backup with pg_dump ---
    systemd.services.kanix-pg-backup = {
      description = "Daily PostgreSQL backup for Kanix";
      serviceConfig = {
        Type = "oneshot";
        User = "postgres";
        Group = "postgres";
        ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p ${cfg.backupDir}";
        ExecStart = pkgs.writeShellScript "kanix-pg-backup" ''
          ${config.services.postgresql.package}/bin/pg_dump \
            --format=custom \
            --file=${cfg.backupDir}/kanix-$(date +%Y%m%d-%H%M%S).dump \
            kanix
        '';
      };
    };

    systemd.timers.kanix-pg-backup = {
      description = "Timer for daily Kanix PostgreSQL backup";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.backupSchedule;
        Persistent = true;
        RandomizedDelaySec = "5m";
      };
    };

    # --- Prune old backups ---
    systemd.services.kanix-pg-backup-prune = {
      description = "Prune old PostgreSQL backups";
      serviceConfig = {
        Type = "oneshot";
        User = "postgres";
        Group = "postgres";
        ExecStart = "${pkgs.findutils}/bin/find ${cfg.backupDir} -name '*.dump' -mtime +${toString cfg.backupRetentionDays} -delete";
      };
    };

    systemd.timers.kanix-pg-backup-prune = {
      description = "Timer to prune old Kanix PostgreSQL backups";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = "daily";
        Persistent = true;
        RandomizedDelaySec = "10m";
      };
    };
  };
}
