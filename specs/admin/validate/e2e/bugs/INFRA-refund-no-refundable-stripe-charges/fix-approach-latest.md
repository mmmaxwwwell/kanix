## Fix approach (iteration 8)

Two concrete changes to `api/src/db/scripts/seed-e2e-refundable-order.ts`:

1. **Root bug — wrong payment status:** The payment row insert used `status: "paid"`. The DB check constraint `ck_payment_status` only allows `['pending','processing','succeeded','failed','canceled']`; `"paid"` is not in that set. Changed to `status: "succeeded"`.

2. **Secondary bug — broken idempotency:** The idempotency guard checked only whether the `order` row existed, then exited early. The orphaned order `E2E-SEED-REFUNDABLE-001` created in the prior failed attempt caused every subsequent run to exit without inserting the missing payment row. Extended the guard to also query for the corresponding `payment` row: if the order exists *and* the payment row exists, skip as before; if the order exists *but* payment is missing (orphaned state), create a fresh Stripe PaymentIntent and insert the payment row with `status: "succeeded"`, then emit `ORDER_ID=` so `setup.sh` can capture it and write `E2E_REFUNDABLE_ORDER_ID` to `.dev/e2e-state/env`.
