{
  description = "Kanix - modular dog handler belt system and commerce platform";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    nix-mcp-debugkit.url = "github:mmmaxwwwell/nix-mcp-debugkit";
    # code-review-graph — spec-kit-managed knowledge graph, pinned in the
    # skill's flake (single source of truth, bumped centrally).
    code-review-graph.url = "path:/home/max/git/agent-framework/.claude/skills/spec-kit/code-review-graph";
    scad.url = "path:./scad";
    site.url = "path:./site";
    api.url = "path:./api";
    admin.url = "path:./admin";
    customer.url = "path:./customer";
    deploy.url = "path:./deploy";
  };

  outputs = { self, nixpkgs, flake-utils, nix-mcp-debugkit, code-review-graph, scad, site, api, admin, customer, deploy }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.android_sdk.accept_license = true;
          # Android SDK components (emulator, system-images, platform-tools,
          # build-tools, etc.) are published under Google's unfree license
          # and each uses its own package name. Rather than enumerate dozens
          # of per-version derivation names, allow unfree for this flake.
          config.allowUnfree = true;
        };
        scadShell = scad.devShells.${system}.default;
        siteShell = site.devShells.${system}.default;
        apiShell = api.devShells.${system}.default;
        adminShell = admin.devShells.${system}.default;
        customerShell = customer.devShells.${system}.default;
        deployShell = deploy.devShells.${system}.default;

        mcp-android = nix-mcp-debugkit.packages.${system}.mcp-android;
        mcp-browser = nix-mcp-debugkit.packages.${system}.mcp-browser;

        crg = code-review-graph.packages.${system}.code-review-graph;
        crgHook = code-review-graph.lib.${system}.mkShellHook {
          projectName = "kanix";
          buildOnEnter = true;
          watch = true;
          serveMcp = false;  # .mcp.json drives MCP config; don't double-spawn
          # Written to a managed block in .code-review-graphignore. Only
          # includes things NOT already in the upstream DEFAULT_IGNORE_PATTERNS
          # list (which already covers node_modules, .venv, dist, build,
          # .dart_tool, .pub-cache, .next, .gradle, vendor, __pycache__, etc).
          # See reference/code-review-graph.md § Per-project excludes.
          excludeDirs = [
            "stl"          # 3D model renders (STL files, not source)
            "test-logs"    # vitest/pytest output
            "logs"         # runtime log dumps
            "validate"     # spec-kit runner validation artifacts
            "attempts"     # spec-kit runner fix-attempt artifacts
            "ci-debug"     # CI diagnostic dumps
            # Flutter-generated desktop runner scaffolding. Kanix ships
            # web + Android only; these files are never edited by hand,
            # but their dense cross-edges (LRESULT, GetCommandLineArguments,
            # win32_window, my_application, etc) dominate the graph's
            # relevance ranking and drown out actual product code when
            # agents query for payment/checkout/shipping context.
            "admin/windows"
            "admin/linux"
            "admin/macos"
            "admin/ios/Runner"
            "customer/windows"
            "customer/linux"
            "customer/macos"
            "customer/ios/Runner"
          ];
        };

        # Android emulator SDK for E2E tests (Linux only)
        # Flutter 3.41.6 requires compileSdk=36, build-tools 35, NDK 28.2.13676358.
        # Include all versions so Gradle never needs to auto-install (which fails
        # on NixOS because downloaded binaries have /lib64 as ELF interpreter).
        androidEmulatorSdk = (pkgs.androidenv.composeAndroidPackages {
          platformVersions = [ "34" "35" "36" ];
          buildToolsVersions = [ "34.0.0" "35.0.0" ];
          cmakeVersions = [ "3.22.1" ];
          includeEmulator = true;
          includeSystemImages = true;
          systemImageTypes = [ "google_apis" ];
          abiVersions = [ "x86_64" ];
          includeNDK = true;
          ndkVersions = [ "28.2.13676358" ];
          includeSources = false;
        }).androidsdk;

        androidHome = "${androidEmulatorSdk}/libexec/android-sdk";

        # Wrapper for the `emulator` binary that always sets
        # ANDROID_USER_HOME / ANDROID_AVD_HOME to the project-local AVD
        # directory.  Inside bwrap sandboxes $HOME is tmpfs, so the
        # default ~/.android/avd/ is empty.  Without this wrapper,
        # `emulator -list-avds` returns nothing and the runner concludes
        # the runtime is not booted.
        emulator-wrapper = pkgs.writeShellScriptBin "emulator" ''
          export ANDROID_USER_HOME="''${ANDROID_USER_HOME:-$PWD/.dev/android-user-home}"
          export ANDROID_AVD_HOME="''${ANDROID_AVD_HOME:-$ANDROID_USER_HOME/avd}"
          # Also create $HOME/.android/avd symlink so the raw SDK emulator
          # (which may be called directly by the runner, bypassing this
          # wrapper) can discover AVDs even inside bwrap sandboxes where
          # $HOME is tmpfs and ~/.android/avd/ is empty.
          if [ -d "$ANDROID_AVD_HOME" ] && [ -w "''${HOME:-/tmp}" ]; then
            mkdir -p "''${HOME}/.android" 2>/dev/null || true
            ln -sfn "$ANDROID_AVD_HOME" "''${HOME}/.android/avd" 2>/dev/null || true
          fi
          exec "${androidHome}/emulator/emulator" "$@"
        '';

        start-emulator = pkgs.writeShellScriptBin "start-emulator" ''
          set -euo pipefail

          export ANDROID_HOME="${androidHome}"
          export ANDROID_SDK_ROOT="$ANDROID_HOME"
          export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$PATH"

          # Set project-local AVD dir early — before any emulator or adb
          # commands — so that `emulator -list-avds` (and the idempotency
          # check) can find the AVD inside bwrap sandboxes where $HOME is
          # tmpfs and ~/.android/avd/ is empty.
          export ANDROID_USER_HOME="''${ANDROID_USER_HOME:-$PWD/.dev/android-user-home}"
          export ANDROID_AVD_HOME="''${ANDROID_AVD_HOME:-$ANDROID_USER_HOME/avd}"
          mkdir -p "$ANDROID_AVD_HOME"

          # Ensure $HOME/.android/avd symlink exists so any process that
          # calls the raw SDK emulator (bypassing the wrapper) can find AVDs.
          # Critical inside bwrap sandboxes where $HOME is tmpfs.
          if [ -w "''${HOME:-/tmp}" ]; then
            mkdir -p "''${HOME}/.android" 2>/dev/null || true
            ln -sfn "$ANDROID_AVD_HOME" "''${HOME}/.android/avd" 2>/dev/null || true
          fi

          AVD_NAME="kanix-e2e"
          BOOT_TIMEOUT=120
          ACTION="start"
          WIPE_DATA=false

          for arg in "$@"; do
            case "$arg" in
              --no-wait) ACTION="start-no-wait" ;;
              --kill)    ACTION="kill" ;;
              --wipe-data) WIPE_DATA=true ;;
              --help|-h)
                echo "Usage: start-emulator [--no-wait] [--kill] [--wipe-data] [--help]"
                exit 0
                ;;
              *) echo "Unknown argument: $arg" >&2; exit 1 ;;
            esac
          done

          kill_emulator() {
            echo "Killing emulator..."
            adb -s emulator-5554 emu kill 2>/dev/null || true
            for i in $(seq 1 10); do
              if ! adb devices 2>/dev/null | grep -q "emulator-5554"; then
                echo "Emulator stopped."
                return 0
              fi
              sleep 1
            done
            echo "Warning: emulator may still be running" >&2
            return 1
          }

          if [ "$ACTION" = "kill" ]; then
            kill_emulator
            exit $?
          fi

          # Idempotency: if an emulator is already running and fully booted, reuse it.
          if adb devices 2>/dev/null | grep -q "emulator-5554.*device"; then
            BOOT_PROP=$(adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null || echo "")
            BOOT_PROP=$(echo "$BOOT_PROP" | tr -d '[:space:]')
            if [ "$BOOT_PROP" = "1" ]; then
              echo "Emulator already running and booted on emulator-5554."
              exit 0
            fi
          fi

          AVD_DIR="$ANDROID_AVD_HOME"

          # Clean stale AVD lock files left by a previous emulator that
          # died without cleanup.  The emulator refuses to start if
          # multiinstance.lock or the running/ directory exist, even when
          # no emulator process is alive.  We only reach this point after
          # the idempotency check above confirmed no emulator is running.
          if [ -d "$AVD_DIR/$AVD_NAME.avd" ]; then
            rm -f "$AVD_DIR/$AVD_NAME.avd/multiinstance.lock" 2>/dev/null || true
            rm -rf "$AVD_DIR/running" 2>/dev/null || true
            echo "Cleaned stale AVD lock files (if any)."
          fi

          if [ ! -d "$AVD_DIR/$AVD_NAME.avd" ]; then
            echo "Creating AVD: $AVD_NAME (API 34, x86_64, 2GB RAM)"
            SYS_IMG="$ANDROID_HOME/system-images/android-34/google_apis/x86_64"
            if [ ! -d "$SYS_IMG" ]; then
              echo "ERROR: System image not found at $SYS_IMG" >&2
              find "$ANDROID_HOME/system-images" -maxdepth 3 -type d 2>/dev/null || true
              exit 1
            fi

            echo "no" | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
              --name "$AVD_NAME" \
              --package "system-images;android-34;google_apis;x86_64" \
              --device "pixel_6" \
              --force 2>&1 || {
                echo "avdmanager failed, creating AVD manually..."
                mkdir -p "$AVD_DIR/$AVD_NAME.avd"
                cat > "$AVD_DIR/$AVD_NAME.ini" <<AVDINI
          avd.ini.encoding=UTF-8
          path=$AVD_DIR/$AVD_NAME.avd
          path.rel=avd/$AVD_NAME.avd
          target=android-34
          AVDINI
                cat > "$AVD_DIR/$AVD_NAME.avd/config.ini" <<CFGINI
          AvdId=$AVD_NAME
          PlayStore.enabled=false
          abi.type=x86_64
          avd.ini.displayname=$AVD_NAME
          avd.ini.encoding=UTF-8
          disk.dataPartition.size=2048M
          hw.accelerator.isAccelerated=yes
          hw.cpu.arch=x86_64
          hw.cpu.ncore=2
          hw.gpu.enabled=yes
          hw.gpu.mode=swiftshader_indirect
          hw.keyboard=yes
          hw.lcd.density=420
          hw.lcd.height=2400
          hw.lcd.width=1080
          hw.ramSize=2048
          hw.sdCard.status=absent
          image.sysdir.1=$SYS_IMG/
          showDeviceFrame=no
          skin.dynamic=yes
          tag.display=Google APIs
          tag.id=google_apis
          vm.heapSize=576
          CFGINI
              }
            echo "AVD created: $AVD_NAME"
          else
            echo "AVD already exists: $AVD_NAME"
          fi

          if [ -w /dev/kvm ]; then
            echo "KVM: available"
            KVM_FLAG="-accel on"
          else
            echo "Warning: /dev/kvm not accessible, emulator will be slow" >&2
            KVM_FLAG="-accel off"
            BOOT_TIMEOUT=600
          fi

          WIPE_FLAG=""
          if [ "$WIPE_DATA" = "true" ]; then
            WIPE_FLAG="-wipe-data"
          fi

          echo "Starting emulator: $AVD_NAME"
          emulator @"$AVD_NAME" \
            -no-window -no-audio -no-boot-anim \
            -gpu swiftshader_indirect \
            $KVM_FLAG -memory 2048 -no-snapshot \
            $WIPE_FLAG -verbose \
            &>"''${TMPDIR:-/tmp}/emulator-$AVD_NAME.log" &
          EMU_PID=$!
          echo "Emulator PID: $EMU_PID"
          echo "Log: ''${TMPDIR:-/tmp}/emulator-$AVD_NAME.log"

          if [ "$ACTION" = "start-no-wait" ]; then
            echo "Emulator started (not waiting for boot)."
            exit 0
          fi

          echo "Waiting for emulator boot (timeout: ''${BOOT_TIMEOUT}s)..."
          ELAPSED=0
          INTERVAL=5
          DEVICE_READY=false

          while [ "$ELAPSED" -lt "$BOOT_TIMEOUT" ]; do
            if ! kill -0 "$EMU_PID" 2>/dev/null; then
              echo "ERROR: Emulator process died. Check log:" >&2
              tail -20 "''${TMPDIR:-/tmp}/emulator-$AVD_NAME.log" >&2
              exit 1
            fi
            if adb devices 2>/dev/null | grep -q "emulator-5554.*device"; then
              DEVICE_READY=true
              break
            fi
            sleep "$INTERVAL"
            ELAPSED=$((ELAPSED + INTERVAL))
            echo "  Waiting for adb device... (''${ELAPSED}s)"
          done

          if [ "$DEVICE_READY" = "false" ]; then
            echo "ERROR: Emulator device did not appear within ''${BOOT_TIMEOUT}s" >&2
            kill "$EMU_PID" 2>/dev/null || true
            tail -20 "''${TMPDIR:-/tmp}/emulator-$AVD_NAME.log" >&2
            exit 1
          fi

          echo "ADB device connected. Waiting for boot_completed..."
          while [ "$ELAPSED" -lt "$BOOT_TIMEOUT" ]; do
            if ! kill -0 "$EMU_PID" 2>/dev/null; then
              echo "ERROR: Emulator process died during boot." >&2
              tail -20 "''${TMPDIR:-/tmp}/emulator-$AVD_NAME.log" >&2
              exit 1
            fi
            BOOT_PROP=$(adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null || echo "")
            BOOT_PROP=$(echo "$BOOT_PROP" | tr -d '[:space:]')
            if [ "$BOOT_PROP" = "1" ]; then
              echo "Emulator booted successfully in ''${ELAPSED}s."
              exit 0
            fi
            sleep "$INTERVAL"
            ELAPSED=$((ELAPSED + INTERVAL))
            echo "  Waiting for boot_completed... (''${ELAPSED}s)"
          done

          echo "ERROR: Emulator did not finish booting within ''${BOOT_TIMEOUT}s" >&2
          tail -20 "''${TMPDIR:-/tmp}/emulator-$AVD_NAME.log" >&2
          kill "$EMU_PID" 2>/dev/null || true
          exit 1
        '';

        # Token-efficiency defaults (see parallel_runner.PlatformRuntime._default_mcp_env).
        # Servers that don't recognize these flags ignore them; when they do recognize
        # them, screenshots are no longer auto-attached to every tool response and
        # the explore/verify agents stop burning ~2k tokens per navigate.
        mcp-android-config = pkgs.writeTextFile {
          name = "mcp-android-config";
          destination = "/mcp/android.json";
          text = builtins.toJSON {
            mcpServers.mcp-android = {
              command = "${mcp-android}/bin/mcp-android";
              args = [];
              env = {
                MCP_PREFER_SNAPSHOT = "1";
                MCP_ANDROID_DEFAULT_NO_VISION = "1";
              };
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
              env = {
                MCP_PREFER_SNAPSHOT = "1";
                MCP_BROWSER_NO_AUTO_SCREENSHOT = "1";
              };
            };
          };
        };
      in
      {
        packages = {
          inherit mcp-android mcp-browser mcp-android-config mcp-browser-config
                  start-emulator emulator-wrapper;
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

            # Stripe CLI — for local webhook forwarding during dev + E2E tests
            stripe-cli

            # Process/port inspection — used by test/e2e/setup.sh to find and
            # kill stale services bound to known ports.
            lsof

            # Android emulator for E2E tests — emulator-wrapper must come
            # before android-tools so that `emulator` resolves to our
            # wrapper (which sets ANDROID_USER_HOME) rather than the bare
            # SDK binary that can't find AVDs inside bwrap sandboxes.
            emulator-wrapper
            android-tools
            start-emulator

            # MCP debug servers — on PATH so .mcp.json can invoke them
            # directly without `nix run` (which needs nix-store write access
            # that bwrap sandboxes don't provide).
            mcp-android
            mcp-browser

            # code-review-graph — persistent knowledge graph, pinned to
            # v2.3.2 in the spec-kit skill.  Used throughout SDD workflow
            # (interview/plan/tasks/implement/review) and kept fresh by
            # the watcher started from shellHook.
            crg

            # Playwright browser bundle — chromium with NixOS-correct
            # RPATHs. PLAYWRIGHT_BROWSERS_PATH below points at this.
            playwright-driver.browsers
          ];

          inputsFrom = [ scadShell siteShell apiShell adminShell customerShell deployShell ];
          OPENSCADPATH = "${scad.packages.${system}.bosl2}";
          LIQUIBASE_CLASSPATH = "${pkgs.postgresql_jdbc}/share/java/postgresql-jdbc.jar";
          # Playwright: pin @playwright/test in site/package.json to whatever
          # version playwright-driver currently ships (1.58.2 / chromium 1208
          # as of nixpkgs unstable 2026-04). Without these, npx playwright
          # downloads its own chromium binary which links against system glib
          # paths that don't exist on NixOS, exiting with libglib-2.0.so.0
          # cannot open shared object file. inputsFrom does not propagate
          # mkShell env vars, so these must be set on the root devshell to
          # take effect inside `nix develop`.
          PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
          ANDROID_HOME = androidHome;
          ANDROID_SDK_ROOT = androidHome;
          # Keep AVD data inside the project tree so it's visible inside
          # bwrap sandboxes (which mount --tmpfs $HOME, hiding ~/.android).
          ANDROID_USER_HOME = ".dev/android-user-home";
          ANDROID_AVD_HOME = ".dev/android-user-home/avd";

          shellHook = crgHook + ''
            # Unset PYTHONPATH that nix's buildPythonApplication setup-hooks
            # leak into the shell (code-review-graph pulls python3.12 deps,
            # mcp-android ships python3.13). Cross-ABI contamination crashes
            # mcp-android at `import pydantic_core._pydantic_core`. Each Python
            # app has its own wrapper with a pinned sys.path — they don't need
            # PYTHONPATH, they only get hurt by it.
            unset PYTHONPATH

            # Do NOT prepend ${androidHome}/emulator to PATH here — it would
            # shadow the emulator-wrapper (listed in packages above) which sets
            # ANDROID_USER_HOME so that `emulator -list-avds` can find AVDs
            # inside bwrap sandboxes.  platform-tools (adb) is already provided
            # by the android-tools package.
            export ANDROID_USER_HOME="$PWD/.dev/android-user-home"
            export ANDROID_AVD_HOME="$PWD/.dev/android-user-home/avd"
            # Disambiguate the Android build root for E2E tests — this repo has
            # two Flutter apps (admin, customer) and the runner's build-detect
            # phase fails with ambiguous_build_root without this hint.  The
            # .mcp.json env block sets the same value for the MCP server process,
            # but the runner reads its own shell env, not .mcp.json.
            export ANDROID_BUILD_ROOT="''${ANDROID_BUILD_ROOT:-customer}"
            # Symlink so raw SDK emulator can also discover AVDs.
            mkdir -p "$HOME/.android" 2>/dev/null || true
            ln -sfn "$ANDROID_AVD_HOME" "$HOME/.android/avd" 2>/dev/null || true
          '';
        };
      }
    );
}
