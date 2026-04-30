# Research: INFRA-refund-no-refundable-stripe-charges

Auto-generated from executor handoff (iteration 7, spawn 2).

## Executor report

- **Symptom** POST /api/admin/orders/<id>/refunds returns 502 ERR_REFUND_PROVIDER_FAILURE for every paid order in the database
- **Evidence** API log at .dev/e2e-state/api.log shows two failure classes:
  1. Seeded orders (pi_wsrt_* pattern): `StripeInvalidRequestError: "No such payment_intent: 'pi_wsrt_1_1777523079285'"` — orderId=95aff8bb (KNX-005750)
  2. Prior-E2E orders (pi_3* pattern): `StripeInvalidRequestError: "This PaymentIntent (pi_3TRj2x58qwlBZD6s06xN3WN9) does not have a successful charge to refund."` — orderId=91caf7c7 (KNX-005719)
  DB query: `SELECT o.order_number, p.provider_payment_intent_id FROM "order" o JOIN payment p ON p.order_id=o.id WHERE o.payment_status='paid' AND p.provider_payment_intent_id LIKE 'pi_3%' LIMIT 5` shows pi_3* IDs exist but Stripe confirms no captured charge on them.
- **Suspected root cause** The E2E checkout flow (T096/T097/T104) creates Stripe payment intents and marks orders as paid in the DB but does not capture the charge — or uses test cards that authorize but do not result in a capturable charge. Seeded orders bypass Stripe entirely (fake IDs). Neither path produces a refundable Stripe charge.
- **Suggested fix location** Either (a) the E2E setup/seed script (test/e2e/setup.sh or seed scripts) should create real captured Stripe test charges for a subset of orders, OR (b) the checkout flow is not capturing payment after authorization — check api/src/flows/ for payment capture logic and ensure `stripe.paymentIntents.capture()` is called after `stripe.paymentIntents.confirm()`.
- **How a fix agent can verify** After fix: `python3 -c "import urllib.request, json; ..."` POST to /api/admin/orders/<fixed-order-id>/refunds with amount=<total> should return 2xx, not 502. Or directly: `stripe payment_intents retrieve <pi_id> --api-key $STRIPE_SECRET_KEY` should show `status: succeeded` and `charges.data[0].captured: true`.
