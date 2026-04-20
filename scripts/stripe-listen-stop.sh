#!/usr/bin/env bash
# Stop the `stripe listen` process started by stripe-listen-start.sh.
# Safe to call when no listener is running (exits 0).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$ROOT_DIR/.dev/stripe-listen.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "no stripe listener tracked (pid file missing)"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
rm -f "$PID_FILE"

if [ -z "$PID" ]; then
  echo "pid file was empty; nothing to stop"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "process $PID not running"
  exit 0
fi

# Verify it's actually our stripe listener before killing, to avoid nuking an
# unrelated PID that may have been reused.
if [ -r "/proc/$PID/cmdline" ] && ! tr '\0' ' ' < "/proc/$PID/cmdline" | grep -q 'stripe.*listen'; then
  echo "pid $PID is not a stripe listener; refusing to kill" >&2
  exit 1
fi

kill "$PID"
# Wait briefly for graceful exit; escalate if needed
for _ in 1 2 3 4 5; do
  kill -0 "$PID" 2>/dev/null || { echo "stopped pid $PID"; exit 0; }
  sleep 0.2
done
kill -9 "$PID" 2>/dev/null || true
echo "force-stopped pid $PID"
