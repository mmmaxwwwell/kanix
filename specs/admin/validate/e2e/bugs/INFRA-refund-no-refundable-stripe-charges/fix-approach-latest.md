Added `api/src/db/scripts/seed-e2e-refundable-order.ts` — a TypeScript script that creates one paid
order backed by a real confirmed Stripe test charge (using `confirm: true` + `payment_method:
pm_card_visa`). The script is idempotent (skips if order E2E-SEED-REFUNDABLE-001 already exists)
and a no-op when STRIPE_SECRET_KEY is a placeholder. Added `"db:seed-e2e-refundable"` to
`api/package.json`. Modified `test/e2e/setup.sh` to run this script after the admin-user seed step
when a real Stripe key is configured; on success it appends `E2E_REFUNDABLE_ORDER_ID=<id>` to
`.dev/e2e-state/env` so verify scripts can reference it. This gives E2E refund tests (T104c) a
real refundable Stripe charge in the database.
