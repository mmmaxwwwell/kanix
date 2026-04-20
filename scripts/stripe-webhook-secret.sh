#!/usr/bin/env bash
# Fetch the Stripe CLI's webhook signing secret and write it to root .env
# as STRIPE_WEBHOOK_SECRET. Creates .env from .env.example if it doesn't exist.
#
# Requires: stripe CLI on PATH and `stripe login` already completed.
# Run this once per `stripe listen` session — the secret changes per session.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
EXAMPLE_FILE="$ROOT_DIR/.env.example"

if ! command -v stripe >/dev/null 2>&1; then
  echo "error: stripe CLI not found on PATH" >&2
  echo "  enter the dev shell first: nix develop" >&2
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
  if ! stripe config --list >/dev/null 2>&1 || ! stripe config --list 2>/dev/null | grep -q 'test_mode_api_key\|live_mode_api_key'; then
    echo "error: stripe CLI is not logged in and STRIPE_SECRET_KEY not set" >&2
    echo "  either run 'stripe login' or set STRIPE_SECRET_KEY in .env" >&2
    exit 1
  fi
fi

echo "Fetching webhook signing secret from Stripe CLI..."
SECRET="$(stripe listen "${API_KEY_FLAG[@]}" --print-secret 2>/dev/null)"

if [[ -z "$SECRET" || ! "$SECRET" =~ ^whsec_ ]]; then
  echo "error: failed to retrieve webhook secret (got: '$SECRET')" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$EXAMPLE_FILE" ]; then
    echo "Creating $ENV_FILE from $EXAMPLE_FILE"
    cp "$EXAMPLE_FILE" "$ENV_FILE"
  else
    echo "Creating empty $ENV_FILE"
    : > "$ENV_FILE"
  fi
fi

# Replace or append STRIPE_WEBHOOK_SECRET line
if grep -q '^STRIPE_WEBHOOK_SECRET=' "$ENV_FILE"; then
  # Use a temp file to avoid sed in-place portability issues
  awk -v secret="$SECRET" '
    /^STRIPE_WEBHOOK_SECRET=/ { print "STRIPE_WEBHOOK_SECRET=" secret; next }
    { print }
  ' "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
  echo "Updated STRIPE_WEBHOOK_SECRET in $ENV_FILE"
else
  echo "STRIPE_WEBHOOK_SECRET=$SECRET" >> "$ENV_FILE"
  echo "Appended STRIPE_WEBHOOK_SECRET to $ENV_FILE"
fi

echo
echo "Remember to restart the API so it picks up the new secret."
