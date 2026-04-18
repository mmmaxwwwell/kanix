#!/usr/bin/env bash
# test/e2e/teardown.sh — Stop backend services started by setup.sh
# Reverses setup.sh in opposite order: astro → api → supertokens → postgres
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_DIR="${STATE_DIR:-$PROJECT_ROOT/.dev/e2e-state}"

# Known service ports (same as setup.sh)
PORT_POSTGRES=5432
PORT_SUPERTOKENS=3567
PORT_API=${PORT:-3000}
PORT_ASTRO=4321

log() { echo "[e2e-teardown] $*"; }

# -------------------------------------------------------------------
# Stop a service by PID file, then verify port is free
# -------------------------------------------------------------------
stop_service() {
  local name=$1 pidfile=$2 port=$3
  log "Stopping ${name}..."

  # Kill by PID file
  if [ -f "$pidfile" ]; then
    local pid
    pid=$(cat "$pidfile" 2>/dev/null || true)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      # Wait up to 5s for graceful shutdown
      local waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 5 ]; do
        sleep 1
        waited=$((waited + 1))
      done
      # Force kill if still running
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    fi
    rm -f "$pidfile"
  fi

  # Also kill anything left on the port
  local pids
  pids=$(lsof -ti "tcp:${port}" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    log "  Cleaning up remaining process(es) on port ${port}"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi

  log "  ${name} stopped."
}

# -------------------------------------------------------------------
# Teardown in reverse order
# -------------------------------------------------------------------
log "=== Tearing down E2E backend services ==="

# 1. Astro site
stop_service "Astro site" "$STATE_DIR/astro.pid" "$PORT_ASTRO"

# 2. API server
stop_service "API server" "$STATE_DIR/api.pid" "$PORT_API"

# 3. SuperTokens
stop_service "SuperTokens" "$STATE_DIR/supertokens.pid" "$PORT_SUPERTOKENS"

# 4. PostgreSQL (use pg_ctl for clean shutdown)
log "Stopping PostgreSQL..."
PGDATA="$PROJECT_ROOT/.dev/pgdata"
if [ -d "$PGDATA" ]; then
  pg_ctl -D "$PGDATA" stop -m fast 2>/dev/null || true
fi
# Clean up any remaining processes on the port
pids=$(lsof -ti "tcp:${PORT_POSTGRES}" 2>/dev/null || true)
if [ -n "$pids" ]; then
  log "  Cleaning up remaining process(es) on port ${PORT_POSTGRES}"
  echo "$pids" | xargs kill -9 2>/dev/null || true
fi
log "  PostgreSQL stopped."

# Clean stale sockets
PGSOCK="$PROJECT_ROOT/.dev/pgsock"
if [ -d "$PGSOCK" ]; then
  rm -f "$PGSOCK"/.s.PGSQL.* 2>/dev/null || true
fi

# Clean up state env file (keep logs for debugging)
rm -f "$STATE_DIR/env"

log ""
log "=== All backend services stopped ==="
