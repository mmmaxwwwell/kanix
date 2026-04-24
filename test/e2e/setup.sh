#!/usr/bin/env bash
# test/e2e/setup.sh — Start backend services for E2E testing
# Starts: postgres → supertokens → api → astro site → android emulator
# Idempotent: safe to run multiple times; kills orphan processes on known ports.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${STATE_DIR:-$PROJECT_ROOT/.dev/e2e-state}"

# Load real third-party keys from root .env into the environment so the
# API server is started with the caller's actual test-mode credentials
# instead of the placeholder fallbacks below. Lines still containing
# REPLACE_ME are skipped so the placeholder path remains the fallback.
# Only keys that are not already set in the parent environment are loaded.
if [ -f "$PROJECT_ROOT/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|PUBLIC_STRIPE_PUBLISHABLE_KEY|EASYPOST_API_KEY|EASYPOST_WEBHOOK_SECRET|GITHUB_OAUTH_CLIENT_ID|GITHUB_OAUTH_CLIENT_SECRET)
        # Strip surrounding quotes if present.
        value="${value%\"}"; value="${value#\"}"
        value="${value%\'}"; value="${value#\'}"
        if [ -n "$value" ] && [ "${value#*REPLACE_ME}" = "$value" ] && [ -z "${!key:-}" ]; then
          export "$key"="$value"
        fi
        ;;
    esac
  done < <(grep -E '^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|PUBLIC_STRIPE_PUBLISHABLE_KEY|EASYPOST_API_KEY|EASYPOST_WEBHOOK_SECRET|GITHUB_OAUTH_CLIENT_ID|GITHUB_OAUTH_CLIENT_SECRET)=' "$PROJECT_ROOT/.env")
fi

# Known service ports
PORT_POSTGRES=5432
PORT_SUPERTOKENS=3567
PORT_API=${PORT:-3000}
PORT_ASTRO=4321

KNOWN_PORTS=("$PORT_POSTGRES" "$PORT_SUPERTOKENS" "$PORT_API" "$PORT_ASTRO")

log() { echo "[e2e-setup] $*"; }
die() { echo "[e2e-setup] ERROR: $*" >&2; exit 1; }

# -------------------------------------------------------------------
# Required tools
#
# Historically setup.sh used `lsof` to find stale processes on known
# ports and silenced errors with `2>/dev/null || true`. When `lsof` was
# missing from the shell's PATH (e.g. run outside `nix develop`), the
# orphan-kill logic became a no-op and stale API processes survived
# across runs — producing a boot that looked like a timeout but was
# really a ghost process holding the port. Fail loudly instead so the
# failure mode is unmissable.
# -------------------------------------------------------------------
require_tool() {
  local tool=$1
  command -v "$tool" >/dev/null 2>&1 || die \
"'$tool' not found in PATH. Run setup inside 'nix develop' so all dev tools are available."
}
require_tool lsof
require_tool ss

# -------------------------------------------------------------------
# Find PIDs bound to a TCP port. Primary path uses lsof; if lsof
# returns nothing we also try `ss` in case lsof can't see processes
# owned by other UIDs / in different PID namespaces.
# -------------------------------------------------------------------
pids_on_port() {
  local port=$1
  local pids
  pids=$(lsof -ti "tcp:${port}" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    pids=$(ss -tlnpH "sport = :${port}" 2>/dev/null \
      | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)
  fi
  echo "$pids"
}

# -------------------------------------------------------------------
# Kill orphan processes on known ports
# -------------------------------------------------------------------
kill_orphans() {
  log "Checking for orphan processes on known ports..."
  for port in "${KNOWN_PORTS[@]}"; do
    local pids
    pids=$(pids_on_port "$port")
    if [ -n "$pids" ]; then
      log "  Killing orphan process(es) on port ${port}: ${pids}"
      echo "$pids" | xargs kill -9 2>/dev/null || true
      sleep 0.5
    fi
  done
}

# -------------------------------------------------------------------
# Clean stale sockets
# -------------------------------------------------------------------
clean_sockets() {
  log "Cleaning stale sockets..."
  local sockdir="$PROJECT_ROOT/.dev/pgsock"
  if [ -d "$sockdir" ]; then
    rm -f "$sockdir"/.s.PGSQL.* 2>/dev/null || true
  fi
}

# -------------------------------------------------------------------
# Wait for a TCP port to become available
# -------------------------------------------------------------------
wait_for_port() {
  local port=$1 label=$2 timeout=${3:-30}
  local elapsed=0
  log "  Waiting for ${label} on port ${port} (timeout: ${timeout}s)..."
  while ! nc -z 127.0.0.1 "$port" 2>/dev/null; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      die "${label} did not start within ${timeout}s on port ${port}"
    fi
  done
  log "  ${label} is ready on port ${port}"
}

# -------------------------------------------------------------------
# Wait for HTTP endpoint to return 200
# -------------------------------------------------------------------
wait_for_http() {
  local url=$1 label=$2 timeout=${3:-30}
  local elapsed=0
  log "  Waiting for ${label} at ${url} (timeout: ${timeout}s)..."
  while ! curl -sf "$url" >/dev/null 2>&1; do
    sleep 1
    elapsed=$((elapsed + 1))
    if [ "$elapsed" -ge "$timeout" ]; then
      die "${label} did not respond at ${url} within ${timeout}s"
    fi
  done
  log "  ${label} is ready at ${url}"
}

# -------------------------------------------------------------------
# Prepare state directory
# -------------------------------------------------------------------
mkdir -p "$STATE_DIR"

# -------------------------------------------------------------------
# Step 0a: Ensure $HOME/.android/avd symlink for emulator AVD discovery
# -------------------------------------------------------------------
# Inside bwrap sandboxes $HOME is tmpfs, so ~/.android/avd/ is empty.
# The runner may call `emulator -list-avds` (raw SDK binary) which looks
# in $HOME/.android/avd/ by default. Create a symlink to the project-local
# AVD directory so it can find AVDs regardless of which emulator binary
# is used or whether ANDROID_USER_HOME is set.
_avd_dir="${ANDROID_AVD_HOME:-$PROJECT_ROOT/.dev/android-user-home/avd}"
if [ -d "$_avd_dir" ] && [ -w "${HOME:-/tmp}" ]; then
  mkdir -p "$HOME/.android" 2>/dev/null || true
  ln -sfn "$_avd_dir" "$HOME/.android/avd" 2>/dev/null || true
fi

# -------------------------------------------------------------------
# Step 0: Kill orphans and clean up
# -------------------------------------------------------------------
kill_orphans
clean_sockets

# -------------------------------------------------------------------
# Step 1: PostgreSQL
# -------------------------------------------------------------------
log "Starting PostgreSQL..."
PGDATA="$PROJECT_ROOT/.dev/pgdata"
PGSOCK="$PROJECT_ROOT/.dev/pgsock"
mkdir -p "$PGSOCK"

if [ ! -d "$PGDATA" ]; then
  log "  Initializing PostgreSQL data directory..."
  initdb -D "$PGDATA" --no-locale --encoding=UTF8 --auth=trust >/dev/null
  {
    echo "listen_addresses = '127.0.0.1'"
    echo "port = ${PORT_POSTGRES}"
    echo "unix_socket_directories = '${PGSOCK}'"
  } >> "$PGDATA/postgresql.conf"
fi

pg_ctl -D "$PGDATA" -l "$STATE_DIR/postgres.log" -o "-p ${PORT_POSTGRES}" start 2>/dev/null || true
wait_for_port "$PORT_POSTGRES" "PostgreSQL" 30

# Create databases and roles (idempotent)
psql -h 127.0.0.1 -p "$PORT_POSTGRES" -d postgres -c \
  "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'kanix') THEN CREATE ROLE kanix WITH LOGIN PASSWORD 'kanix'; END IF; END \$\$;" \
  2>/dev/null || true
createdb -h 127.0.0.1 -p "$PORT_POSTGRES" -O kanix kanix 2>/dev/null || true
psql -h 127.0.0.1 -p "$PORT_POSTGRES" -d kanix -c "GRANT ALL PRIVILEGES ON DATABASE kanix TO kanix;" 2>/dev/null || true
psql -h 127.0.0.1 -p "$PORT_POSTGRES" -d kanix -c "GRANT ALL ON SCHEMA public TO kanix;" 2>/dev/null || true
createdb -h 127.0.0.1 -p "$PORT_POSTGRES" supertokens 2>/dev/null || true
log "PostgreSQL ready."

# -------------------------------------------------------------------
# Step 2: SuperTokens
# -------------------------------------------------------------------
log "Starting SuperTokens..."
ST_DIR="$PROJECT_ROOT/.dev/supertokens/supertokens"

if [ ! -d "$ST_DIR" ]; then
  log "  Running SuperTokens setup..."
  bash "$PROJECT_ROOT/scripts/setup-supertokens.sh"
fi

# Ensure config.yaml has PostgreSQL connection
if [ -f "$ST_DIR/config.yaml" ] && ! grep -q '^postgresql_connection_uri:' "$ST_DIR/config.yaml"; then
  cp "$ST_DIR/config.yaml.original" "$ST_DIR/config.yaml" 2>/dev/null || true
  printf '\nport: %s\nhost: 0.0.0.0\npostgresql_connection_uri: "postgresql://127.0.0.1:%s/supertokens"\n' \
    "$PORT_SUPERTOKENS" "$PORT_POSTGRES" >> "$ST_DIR/config.yaml"
fi

# Start SuperTokens in background
if ! nc -z 127.0.0.1 "$PORT_SUPERTOKENS" 2>/dev/null; then
  (
    cd "$ST_DIR"
    java -classpath "core/*:plugin-interface/*:plugin/*:ee/*" \
      io.supertokens.Main "$ST_DIR" DEV
  ) > "$STATE_DIR/supertokens.log" 2>&1 &
  echo $! > "$STATE_DIR/supertokens.pid"
fi
wait_for_http "http://127.0.0.1:${PORT_SUPERTOKENS}/hello" "SuperTokens" 60
log "SuperTokens ready."

# -------------------------------------------------------------------
# Step 3: Run database migrations
# -------------------------------------------------------------------
log "Running database migrations..."
(cd "$PROJECT_ROOT/api" && pnpm db:migrate) > "$STATE_DIR/migrate.log" 2>&1 || {
  log "  WARNING: Migration failed (may already be applied). See $STATE_DIR/migrate.log"
}

# -------------------------------------------------------------------
# Step 4: API server
# -------------------------------------------------------------------
log "Starting API server..."

# Ensure .env exists for the API
if [ ! -f "$PROJECT_ROOT/.env" ] && [ -f "$PROJECT_ROOT/.env.example" ]; then
  cp "$PROJECT_ROOT/.env.example" "$PROJECT_ROOT/.env"
  log "  Created .env from .env.example (using defaults)"
fi

# Validate api.pid: the recorded pid must exist AND actually be our API
# process AND be bound to PORT_API. A bare `kill -0 $pid` check passes for
# any live pid on the host (pid reuse after reboots or long gaps), which
# previously made the script think the API was "already running" when the
# recorded pid had been reassigned to an unrelated process — skipping the
# port-cleanup block below and causing EADDRINUSE when the real listener
# was a stale node from an earlier run.
api_already_running=false

# Fast path: if the API health endpoint is already responding, skip the
# PID-file and port-ownership checks entirely.  This handles the common
# case where the API was started by a prior setup.sh run whose process
# lives in a different PID namespace (containers, Claude Code sandbox)
# and is invisible to lsof / kill / ps — but the service itself is fine.
if curl -sf "http://127.0.0.1:${PORT_API}/health" >/dev/null 2>&1; then
  api_already_running=true
  log "  API already healthy on port ${PORT_API}, skipping start"
fi

if [ "$api_already_running" = false ] && [ -f "$STATE_DIR/api.pid" ]; then
  old_api_pid=$(cat "$STATE_DIR/api.pid" 2>/dev/null || echo "")
  pid_cmd=""
  if [ -n "$old_api_pid" ] && kill -0 "$old_api_pid" 2>/dev/null; then
    pid_cmd=$(ps -p "$old_api_pid" -o args= 2>/dev/null || true)
  fi
  port_pids=$(pids_on_port "$PORT_API")
  if [ -n "$old_api_pid" ] \
     && echo "$pid_cmd" | grep -qE "(dist/index\.js|tsx .*src/index\.ts)" \
     && echo "$port_pids" | tr ' ' '\n' | grep -qx "$old_api_pid"; then
    api_already_running=true
    log "  API already running (pid ${old_api_pid}), skipping start"
  else
    if [ -n "$old_api_pid" ]; then
      log "  Discarding stale api.pid=${old_api_pid} (not our API or not bound to ${PORT_API})"
    fi
    rm -f "$STATE_DIR/api.pid"
  fi
fi

# Kill anything holding the port so the new server can bind. Loop because
# a killed process can respawn from a watcher parent, and we also want to
# verify the port is free after the kill — not just that we sent signals.
if [ "$api_already_running" = false ]; then
  for attempt in 1 2 3; do
    api_pids=$(pids_on_port "$PORT_API")
    if [ -z "$api_pids" ] && ! nc -z 127.0.0.1 "$PORT_API" 2>/dev/null; then
      break
    fi
    if [ -n "$api_pids" ]; then
      log "  Killing stale process(es) on port ${PORT_API} (attempt ${attempt}): ${api_pids}"
      echo "$api_pids" | xargs kill -9 2>/dev/null || true
    fi
    # Close orphaned sockets invisible to lsof (e.g. PID-namespace ghosts)
    if nc -z 127.0.0.1 "$PORT_API" 2>/dev/null; then
      log "  Port ${PORT_API} still held after kill; closing via ss --kill"
      ss --kill state listening src "0.0.0.0:${PORT_API}" 2>/dev/null || true
    fi
    sleep 1
  done
  if nc -z 127.0.0.1 "$PORT_API" 2>/dev/null; then
    die "Port ${PORT_API} still occupied after 3 cleanup attempts; refusing to start API"
  fi
fi

if [ "$api_already_running" = false ]; then
  # Export env vars for the API (used by both build and start).
  # Secret keys must be real env vars (config.ts ignores them from .env).
  # DATABASE_URL and SUPERTOKENS_API_KEY point at local services started above.
  # Third-party keys: real test-mode values are loaded from root .env at
  # the top of this script; the defaults below are placeholder strings
  # that the API recognizes and routes to the stub adapters.
  export DATABASE_URL="postgresql://kanix:kanix@127.0.0.1:${PORT_POSTGRES}/kanix"
  export SUPERTOKENS_API_KEY="e2e-test-key"
  export STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-sk_test_e2e_placeholder_key}"
  export STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_e2e_placeholder_secret}"
  export EASYPOST_API_KEY="${EASYPOST_API_KEY:-EZAK_REPLACE_ME}"
  export EASYPOST_WEBHOOK_SECRET="${EASYPOST_WEBHOOK_SECRET:-whsec_e2e_easypost}"
  export GITHUB_OAUTH_CLIENT_ID="${GITHUB_OAUTH_CLIENT_ID:-e2e-github-client-id}"
  export GITHUB_OAUTH_CLIENT_SECRET="${GITHUB_OAUTH_CLIENT_SECRET:-e2e-github-client-secret}"
  export PUBLIC_STRIPE_PUBLISHABLE_KEY="${PUBLIC_STRIPE_PUBLISHABLE_KEY:-pk_test_e2e_placeholder_key}"

  # Pre-build TypeScript so the server starts from compiled JS (~1s)
  # instead of tsx watch (~30s cold-compile for the large server.ts).
  log "  Building API (tsc)..."
  (cd "$PROJECT_ROOT/api" && pnpm build) > "$STATE_DIR/api-build.log" 2>&1 || {
    log "  WARNING: tsc build failed, falling back to tsx (no watch)"
  }

  (
    cd "$PROJECT_ROOT/api"
    if [ -f dist/index.js ]; then
      PORT="$PORT_API" node dist/index.js
    else
      # tsx without --watch starts faster (no fs-watcher overhead)
      PORT="$PORT_API" npx tsx src/index.ts
    fi
  ) > "$STATE_DIR/api.log" 2>&1 &
  echo $! > "$STATE_DIR/api.pid"
fi
wait_for_port "$PORT_API" "API server" 60
log "API server ready."

# -------------------------------------------------------------------
# Step 5: Astro site (dev server)
# -------------------------------------------------------------------
log "Starting Astro site..."

# Fast path: if the Astro dev server is already serving pages, skip restart.
# Same rationale as the API health check above (cross-namespace visibility).
if curl -so /dev/null -w '' "http://127.0.0.1:${PORT_ASTRO}/" 2>/dev/null; then
  log "  Astro site already healthy on port ${PORT_ASTRO}, skipping start"
elif ! nc -z 127.0.0.1 "$PORT_ASTRO" 2>/dev/null; then
  # Ensure site dependencies are installed before starting
  log "  Installing site dependencies..."
  (cd "$PROJECT_ROOT/site" && npm install --prefer-offline) >> "$STATE_DIR/astro.log" 2>&1 || {
    log "  WARNING: npm install had issues, attempting to start anyway"
  }
  (
    cd "$PROJECT_ROOT/site"
    npm run dev -- --port "$PORT_ASTRO" --host 127.0.0.1
  ) >> "$STATE_DIR/astro.log" 2>&1 &
  echo $! > "$STATE_DIR/astro.pid"
fi
wait_for_port "$PORT_ASTRO" "Astro site" 60
log "Astro site ready."

# -------------------------------------------------------------------
# Step 6: Android emulator (opt-in, gated by E2E_WANT_EMULATOR=1)
# -------------------------------------------------------------------
# The emulator is a 3+GB qemu-system-x86 process and takes 25s+ to boot.
# Integration-test tasks that only harden a single *.integration.test.ts
# file do not need it — they only need postgres + supertokens + API.
# Booting it unconditionally (and leaving it running between tasks)
# accounted for ~3.2GB of resident memory that accumulated across many
# serial agent runs and pushed total system memory to 95%.
#
# The runner's PlatformManager sets E2E_WANT_EMULATOR=1 only for tasks
# tagged [needs: mcp-android].  E2E driver scripts that need an emulator
# directly can also export E2E_WANT_EMULATOR=1 before calling setup.sh.
if [ "${E2E_WANT_EMULATOR:-0}" = "1" ]; then
  if command -v start-emulator >/dev/null 2>&1; then
    log "Starting Android emulator (E2E_WANT_EMULATOR=1)..."
    if start-emulator 2>"$STATE_DIR/emulator.log"; then
      log "Android emulator ready."

      # adb reverse: device localhost:N → host 127.0.0.1:N.
      # Required for apps running on the emulator to reach host services
      # (API on PORT_API, SuperTokens on PORT_SUPERTOKENS). adb reverse
      # rules don't survive emulator restarts, so re-apply every setup run.
      if command -v adb >/dev/null 2>&1; then
        log "  Wiring adb reverse: ${PORT_API}, ${PORT_SUPERTOKENS}..."
        adb -s emulator-5554 reverse --remove-all 2>/dev/null || true
        adb -s emulator-5554 reverse "tcp:${PORT_API}" "tcp:${PORT_API}" \
          2>>"$STATE_DIR/emulator.log" \
          || log "  WARNING: adb reverse tcp:${PORT_API} failed"
        adb -s emulator-5554 reverse "tcp:${PORT_SUPERTOKENS}" "tcp:${PORT_SUPERTOKENS}" \
          2>>"$STATE_DIR/emulator.log" \
          || log "  WARNING: adb reverse tcp:${PORT_SUPERTOKENS} failed"
      else
        log "  WARNING: adb not in PATH — device→host port forwards not configured"
      fi
    else
      log "  WARNING: start-emulator exited $? — see $STATE_DIR/emulator.log"
    fi
  fi
else
  log "Skipping Android emulator (E2E_WANT_EMULATOR not set)."
fi

# -------------------------------------------------------------------
# Step 6b: Pre-build Flutter APK to trigger SDK overlay + auto-install
# -------------------------------------------------------------------
# On NixOS, the Flutter and Android SDKs live in /nix/store (read-only).
# settings.gradle.kts creates writable overlays and Gradle auto-installs
# missing components (NDK, platforms, build-tools).  The auto-installed
# binaries are pre-built for FHS Linux and have /lib64/ld-linux-x86-64.so.2
# as their ELF interpreter, which doesn't exist on NixOS.  We trigger one
# build to create the overlays + download components, then patchelf all
# binaries so subsequent builds succeed.
if [ "${E2E_WANT_EMULATOR:-0}" = "1" ] && command -v flutter >/dev/null 2>&1 && command -v patchelf >/dev/null 2>&1; then
  for _app_dir in "$PROJECT_ROOT/customer" "$PROJECT_ROOT/admin"; do
    _sdk_overlay="$_app_dir/.dev/android-sdk"
    _patched_marker="$_sdk_overlay/.nixos-patched"
    if [ -d "$_app_dir/android" ] && [ ! -f "$_patched_marker" ]; then
      # Resolve pub dependencies first — flutter build does NOT auto-run
      # pub get when the .pub-cache is empty, causing compilation failures.
      log "Resolving Flutter deps in $_app_dir..."
      (cd "$_app_dir" && flutter pub get) >/dev/null 2>&1 || true

      # Trigger settings.gradle.kts overlay creation with a minimal Gradle
      # invocation instead of a full assembleDebug (~5s vs ~250s).  The
      # overlay is created during Gradle's configuration phase (settings
      # script evaluation), so any task works.
      log "Triggering Gradle SDK overlay in $_app_dir/android..."
      (cd "$_app_dir/android" && ./gradlew projects --no-daemon -q) >/dev/null 2>&1 || true

      # Patch all ELF binaries with wrong interpreter
      if [ -d "$_sdk_overlay" ]; then
        _nix_interp=$(find /nix/store -maxdepth 3 -name 'ld-linux-x86-64.so.2' -path '*/glibc*/lib/*' 2>/dev/null | head -1)
        _nix_zlib=$(find /nix/store -maxdepth 3 -name 'libz.so.1' -path '*/zlib*/lib/*' 2>/dev/null | head -1)
        _nix_zlib_dir=$(dirname "$_nix_zlib" 2>/dev/null || true)

        if [ -n "$_nix_interp" ]; then
          log "  Patching ELF binaries in $_sdk_overlay..."
          find "$_sdk_overlay" -type f -executable 2>/dev/null | while read _f; do
            _interp=$(readelf -l "$_f" 2>/dev/null | grep -oP '(?<=Requesting program interpreter: )/[^\]]+' || true)
            if [ "$_interp" = "/lib64/ld-linux-x86-64.so.2" ]; then
              patchelf --set-interpreter "$_nix_interp" "$_f" 2>/dev/null || true
              if [ -n "$_nix_zlib_dir" ]; then
                _rpath=$(patchelf --print-rpath "$_f" 2>/dev/null || true)
                if [ -n "$_rpath" ]; then
                  patchelf --set-rpath "$_rpath:$_nix_zlib_dir" "$_f" 2>/dev/null || true
                else
                  patchelf --set-rpath "$_nix_zlib_dir" "$_f" 2>/dev/null || true
                fi
              fi
            fi
          done
          # Also patch Gradle-cached AAPT2
          find "$HOME/.gradle/caches" -name 'aapt2' -type f 2>/dev/null | while read _f; do
            _interp=$(readelf -l "$_f" 2>/dev/null | grep -oP '(?<=Requesting program interpreter: )/[^\]]+' || true)
            if [ "$_interp" = "/lib64/ld-linux-x86-64.so.2" ]; then
              patchelf --set-interpreter "$_nix_interp" "$_f" 2>/dev/null || true
            fi
          done
        fi
        # Write marker whether or not patching was needed — the overlay
        # symlinks to Nix store binaries which are already patched.
        echo "patched" > "$_patched_marker"
        log "  SDK overlay ready."
      fi
    fi
  done
fi

# -------------------------------------------------------------------
# Step 7: Write state/env file
# -------------------------------------------------------------------
STRIPE_KEY_PRESENT="false"
if [ -f "$PROJECT_ROOT/.env" ] && grep -q 'STRIPE_SECRET_KEY=sk_test_' "$PROJECT_ROOT/.env" && \
   ! grep -q 'STRIPE_SECRET_KEY=sk_test_REPLACE_ME' "$PROJECT_ROOT/.env"; then
  STRIPE_KEY_PRESENT="true"
fi

cat > "$STATE_DIR/env" <<ENVEOF
# E2E environment — generated by test/e2e/setup.sh
POSTGRES_URL=postgresql://kanix:kanix@127.0.0.1:${PORT_POSTGRES}/kanix
SUPERTOKENS_URL=http://127.0.0.1:${PORT_SUPERTOKENS}
API_URL=http://127.0.0.1:${PORT_API}
ASTRO_URL=http://127.0.0.1:${PORT_ASTRO}
ADMIN_EMAIL=admin@kanix.test
ADMIN_PASSWORD=TestAdmin123!
STRIPE_TEST_KEY_PRESENT=${STRIPE_KEY_PRESENT}
ENVEOF

# Also emit a sourceable shell snippet for consumers (spec-kit pre-E2E
# gate, ad-hoc developer shells) that need the exact env the API was
# started with. Keep in sync with the `export` block in Step 5.
cat > "$STATE_DIR/env.sh" <<ENVSHEOF
# Source this file to get the env the API is running with.
# Generated by test/e2e/setup.sh — do not edit by hand.
export DATABASE_URL="postgresql://kanix:kanix@127.0.0.1:${PORT_POSTGRES}/kanix"
export SUPERTOKENS_CONNECTION_URI="http://127.0.0.1:${PORT_SUPERTOKENS}"
export SUPERTOKENS_API_KEY="e2e-test-key"
export STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-sk_test_e2e_placeholder_key}"
export STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_e2e_placeholder_secret}"
export EASYPOST_API_KEY="${EASYPOST_API_KEY:-EZAK_REPLACE_ME}"
export EASYPOST_WEBHOOK_SECRET="${EASYPOST_WEBHOOK_SECRET:-whsec_e2e_easypost}"
export GITHUB_OAUTH_CLIENT_ID="${GITHUB_OAUTH_CLIENT_ID:-e2e-github-client-id}"
export GITHUB_OAUTH_CLIENT_SECRET="${GITHUB_OAUTH_CLIENT_SECRET:-e2e-github-client-secret}"
export PUBLIC_STRIPE_PUBLISHABLE_KEY="${PUBLIC_STRIPE_PUBLISHABLE_KEY:-pk_test_e2e_placeholder_key}"
export PORT="${PORT_API}"
ENVSHEOF

log "State written to ${STATE_DIR}/env"
log ""
log "=== All backend services are running ==="
log "  PostgreSQL:   127.0.0.1:${PORT_POSTGRES}"
log "  SuperTokens:  http://127.0.0.1:${PORT_SUPERTOKENS}"
log "  API:          http://127.0.0.1:${PORT_API}"
log "  Astro site:   http://127.0.0.1:${PORT_ASTRO}"
log "  State dir:    ${STATE_DIR}"
