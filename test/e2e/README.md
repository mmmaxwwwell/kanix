# E2E Testing

End-to-end tests for Kanix. Tests that exercise real external services (Stripe,
EasyPost, SuperTokens) are gated on those services being reachable; tests that
don't need them run unconditionally.

## Prerequisites

Enter the Nix dev shell first — it provides `stripe`, `node`, `pnpm`, `flutter`,
MCP servers, etc.:

```bash
nix develop
```

## Stripe webhook forwarding

Tests that drive real Stripe payments (T096, T097, T104c, T104f) need
`stripe listen` running so webhook events reach the local API at
`localhost:3000/webhooks/stripe`. Orders otherwise stay in `pending_payment`
forever and state assertions fail.

Agents and scripts control the listener lifecycle explicitly:

```bash
# Start — idempotent. Prints JSON {pid, secret, forward_to, log, reused}.
# Writes STRIPE_WEBHOOK_SECRET into root .env automatically.
# After this runs, RESTART the API so it picks up the new secret.
pnpm --dir api stripe:listen:start

# Stop — safe to call when no listener is running.
pnpm --dir api stripe:listen:stop
```

The listener must be running **before** the API starts (or the API must be
restarted after `start` writes the new secret). The webhook secret rotates per
`stripe listen` session, which is why the scripts always update `.env`.

### Agent usage pattern

```bash
RESULT=$(pnpm --dir api stripe:listen:start)
PID=$(echo "$RESULT" | jq -r .pid)
SECRET=$(echo "$RESULT" | jq -r .secret)

# (restart API so it reads the new secret)

# ... drive tests ...

pnpm --dir api stripe:listen:stop
```

The start script is idempotent — calling it twice detects the existing
listener, re-fetches its secret into `.env`, and returns `"reused": true`. Stale
PID files (from a crashed previous run) are cleaned up automatically.

### First-time setup

Before any of this works you need:

1. A Stripe account (free) and test API keys:
   - https://dashboard.stripe.com/test/apikeys
   - Copy `sk_test_…` into `STRIPE_SECRET_KEY` in root `.env`
   - Copy `pk_test_…` into `PUBLIC_STRIPE_PUBLISHABLE_KEY` in root `.env`
2. `stripe login` (opens a browser, one-time pairing with your account)

`STRIPE_WEBHOOK_SECRET` is managed by the listen scripts — you don't set it
manually.

## Running tests

```bash
bash test/e2e/setup.sh       # prereq verification + environment setup
# ... run the specific E2E harness (Playwright / Patrol) ...
bash test/e2e/teardown.sh    # cleanup
```

Tests that depend on Stripe should check for a live listener (PID file exists
and process is alive) and skip cleanly with a clear message when it isn't
running, so the rest of the suite remains runnable without Stripe credentials.

## Scripts reference

| Script | Purpose |
|--------|---------|
| [scripts/stripe-listen-start.sh](../../scripts/stripe-listen-start.sh) | Start `stripe listen`, capture PID + secret, write to `.env` |
| [scripts/stripe-listen-stop.sh](../../scripts/stripe-listen-stop.sh) | Kill the tracked listener, clean up PID file |
| [scripts/stripe-webhook-secret.sh](../../scripts/stripe-webhook-secret.sh) | One-shot: fetch current secret and write to `.env` (no background process) |
| [scripts/sync-env.sh](../../scripts/sync-env.sh) | Copy `PUBLIC_*` vars from root `.env` to `site/.env` |
