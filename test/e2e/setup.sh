#!/usr/bin/env bash
# test/e2e/setup.sh — Start backend services for E2E testing
# Starts: postgres → supertokens → api → astro site
# Idempotent: safe to run multiple times; kills orphan processes on known ports.
# The Android emulator is managed by the spec-kit runner's PlatformManager, not this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${STATE_DIR:-$PROJECT_ROOT/.dev/e2e-state}"

# Known service ports
PORT_POSTGRES=5432
PORT_SUPERTOKENS=3567
PORT_API=${PORT:-3000}
PORT_ASTRO=4321

KNOWN_PORTS=("$PORT_POSTGRES" "$PORT_SUPERTOKENS" "$PORT_API" "$PORT_ASTRO")

log() { echo "[e2e-setup] $*"; }
die() { echo "[e2e-setup] ERROR: $*" >&2; exit 1; }

# -------------------------------------------------------------------
# Kill orphan processes on known ports
# -------------------------------------------------------------------
kill_orphans() {
  log "Checking for orphan processes on known ports..."
  for port in "${KNOWN_PORTS[@]}"; do
    local pids
    pids=$(lsof -ti "tcp:${port}" 2>/dev/null || true)
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

if ! nc -z 127.0.0.1 "$PORT_API" 2>/dev/null; then
  (
    cd "$PROJECT_ROOT/api"
    # Secret keys must be real env vars (config.ts ignores them from .env).
    # DATABASE_URL and SUPERTOKENS_API_KEY point at local services started above.
    # Third-party keys use test-mode dummies — E2E tests don't call real APIs.
    export DATABASE_URL="postgresql://kanix:kanix@127.0.0.1:${PORT_POSTGRES}/kanix"
    export SUPERTOKENS_API_KEY="e2e-test-key"
    export STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-sk_test_e2e_placeholder_key}"
    export STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_e2e_placeholder_secret}"
    export EASYPOST_API_KEY="${EASYPOST_API_KEY:-EZAK_REPLACE_ME}"
    export EASYPOST_WEBHOOK_SECRET="${EASYPOST_WEBHOOK_SECRET:-whsec_e2e_easypost}"
    export GITHUB_OAUTH_CLIENT_ID="${GITHUB_OAUTH_CLIENT_ID:-e2e-github-client-id}"
    export GITHUB_OAUTH_CLIENT_SECRET="${GITHUB_OAUTH_CLIENT_SECRET:-e2e-github-client-secret}"
    export PUBLIC_STRIPE_PUBLISHABLE_KEY="${PUBLIC_STRIPE_PUBLISHABLE_KEY:-pk_test_e2e_placeholder_key}"
    PORT="$PORT_API" pnpm dev
  ) > "$STATE_DIR/api.log" 2>&1 &
  echo $! > "$STATE_DIR/api.pid"
fi
wait_for_port "$PORT_API" "API server" 30
log "API server ready."

# -------------------------------------------------------------------
# Step 5: Astro site (dev server)
# -------------------------------------------------------------------
log "Starting Astro site..."

if ! nc -z 127.0.0.1 "$PORT_ASTRO" 2>/dev/null; then
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
# Step 6: Write state/env file
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

log "State written to ${STATE_DIR}/env"
log ""
log "=== All backend services are running ==="
log "  PostgreSQL:   127.0.0.1:${PORT_POSTGRES}"
log "  SuperTokens:  http://127.0.0.1:${PORT_SUPERTOKENS}"
log "  API:          http://127.0.0.1:${PORT_API}"
log "  Astro site:   http://127.0.0.1:${PORT_ASTRO}"
log "  State dir:    ${STATE_DIR}"
