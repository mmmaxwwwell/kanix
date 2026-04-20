#!/usr/bin/env bash
# Start a `stripe listen` background process, write its webhook signing secret
# to root .env as STRIPE_WEBHOOK_SECRET, and print a JSON summary.
#
# Usage:
#   stripe-listen-start.sh [--forward-to URL]
#
# Output (JSON, to stdout):
#   {"pid": 12345, "secret": "whsec_...", "forward_to": "localhost:3000/webhooks/stripe", "log": "/path/to/log"}
#
# Semantics:
#   - If a live listener already exists (PID file matches a running `stripe listen`),
#     reuse it: re-fetch secret, update .env, print existing PID.
#   - Stale PID files are detected and overwritten.
#   - Requires: stripe CLI on PATH and `stripe login` completed.
#
# Teardown:
#   scripts/stripe-listen-stop.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_DIR="$ROOT_DIR/.dev"
PID_FILE="$DEV_DIR/stripe-listen.pid"
LOG_FILE="$DEV_DIR/stripe-listen.log"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_FILE="$ROOT_DIR/.env.example"

FORWARD_TO="localhost:3000/webhooks/stripe"
while [ $# -gt 0 ]; do
  case "$1" in
    --forward-to) FORWARD_TO="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$DEV_DIR"

# --- prereqs ----------------------------------------------------------------

if ! command -v stripe >/dev/null 2>&1; then
  echo "error: stripe CLI not found on PATH (enter nix develop first)" >&2
  exit 1
fi

# Load STRIPE_SECRET_KEY from .env if available
if [ -f "$ENV_FILE" ]; then
  STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-$(grep '^STRIPE_SECRET_KEY=' "$ENV_FILE" | cut -d= -f2- || true)}"
fi
API_KEY_FLAG=()
if [ -n "${STRIPE_SECRET_KEY:-}" ] && [[ ! "$STRIPE_SECRET_KEY" =~ REPLACE_ME ]]; then
  API_KEY_FLAG=(--api-key "$STRIPE_SECRET_KEY")
fi

if [ ${#API_KEY_FLAG[@]} -eq 0 ]; then
  if ! stripe config --list >/dev/null 2>&1; then
    echo "error: stripe CLI not logged in and STRIPE_SECRET_KEY not set" >&2
    echo "  either run 'stripe login' or set STRIPE_SECRET_KEY in .env" >&2
    exit 1
  fi
fi

# --- helpers ----------------------------------------------------------------

is_live_listener() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  # Check the process is actually `stripe listen`, not an unrelated PID
  # (ps comm may be truncated; check the full cmdline on /proc where available)
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'stripe.*listen' || return 1
  fi
  return 0
}

fetch_secret() {
  local secret
  secret="$(stripe listen "${API_KEY_FLAG[@]}" --print-secret 2>/dev/null || true)"
  if [[ -z "$secret" || ! "$secret" =~ ^whsec_ ]]; then
    echo "error: failed to retrieve webhook secret from stripe CLI" >&2
    exit 1
  fi
  printf '%s' "$secret"
}

write_env() {
  local secret="$1"
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$EXAMPLE_FILE" ]; then
      cp "$EXAMPLE_FILE" "$ENV_FILE"
    else
      : > "$ENV_FILE"
    fi
  fi
  if grep -q '^STRIPE_WEBHOOK_SECRET=' "$ENV_FILE"; then
    awk -v s="$secret" '
      /^STRIPE_WEBHOOK_SECRET=/ { print "STRIPE_WEBHOOK_SECRET=" s; next }
      { print }
    ' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    echo "STRIPE_WEBHOOK_SECRET=$secret" >> "$ENV_FILE"
  fi
}

# --- reuse path -------------------------------------------------------------

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if is_live_listener "$EXISTING_PID"; then
    SECRET="$(fetch_secret)"
    write_env "$SECRET"
    printf '{"pid":%s,"secret":"%s","forward_to":"%s","log":"%s","reused":true}\n' \
      "$EXISTING_PID" "$SECRET" "$FORWARD_TO" "$LOG_FILE"
    exit 0
  fi
  # stale pid file — remove
  rm -f "$PID_FILE"
fi

# --- fresh start ------------------------------------------------------------

SECRET="$(fetch_secret)"
write_env "$SECRET"

# Start listener in background; nohup so it survives the parent shell exit.
# Redirect output to the log file for debugging.
nohup stripe listen "${API_KEY_FLAG[@]}" --forward-to "$FORWARD_TO" >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

# Verify it actually started (nohup returns immediately even on failure)
sleep 1
if ! is_live_listener "$PID"; then
  rm -f "$PID_FILE"
  echo "error: stripe listen failed to start; see $LOG_FILE" >&2
  tail -5 "$LOG_FILE" >&2 || true
  exit 1
fi

printf '{"pid":%s,"secret":"%s","forward_to":"%s","log":"%s","reused":false}\n' \
  "$PID" "$SECRET" "$FORWARD_TO" "$LOG_FILE"
