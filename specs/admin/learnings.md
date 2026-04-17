# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T046 — Implement cart API
- Fastify rejects `POST` with `Content-Type: application/json` and no body (`FST_ERR_CTP_EMPTY_JSON_BODY`) — for endpoints that accept an empty POST, tests must send `body: JSON.stringify({})` or omit the Content-Type header
- Cart routes use a separate `if (database)` block with `const db = database.db` captured up front — this avoids TypeScript narrowing issues inside closures where `database` could be `undefined`
- `addCartItem` merges quantity when the same variant is already in the cart (idempotent add) — check existing cart_line before insert and update quantity if found

## T047 — Implement kit composition system
- Kit validation checks class requirements first (fail fast on missing selections), then validates each variant individually — this ordering gives the best error messages ("Select 2 more from Plates" vs generic "invalid selection")
- The dynamic import `await import("../schema/product-class.js")` inside `addKitToCart` works for getting the `productClass` table reference when constructing the human-readable error message — avoid circular deps by not importing it at top level alongside `productClassMembership`
- Out-of-stock swap suggestions scan all products in the same class for active, in-stock variants — limit results with `.slice(0, 3)` to avoid bloating the error response

## T048 — Implement Stripe Tax adapter
- The `stripe` package (v22) has a clean `stripe.tax.calculations.create()` API — pass `customer_details.address_source: "shipping"` to calculate tax based on the shipping address
- Use the same factory + DI pattern as `LowStockAlertService` — expose `taxAdapter` on `ServerInstance` and accept an override in `CreateServerOptions` so tests can inject a stub without calling the real Stripe API
- Stripe Tax integration tests should be conditionally skipped (`STRIPE_TAX_ENABLED=true` + `sk_test_` prefix) so the test suite passes in environments without Stripe test keys

## T049 — Implement checkout flow
- Extend the adapter DI pattern to shipping and payment — `ShippingAdapter` and `PaymentAdapter` follow the same factory + `CreateServerOptions` override pattern as `TaxAdapter`, enabling stub injection in tests without external API calls
- The `@easypost/api` package isn't installed yet — use `await import("@easypost/api" as string)` dynamic import with type erasure so TypeScript compiles without the package; the stub adapter handles all test and dev scenarios
- Order number generation with `KNX-` prefix uses `COUNT(*)` on the order table — sufficient for V1 but should migrate to a PostgreSQL SEQUENCE for concurrent-safe numbering at scale

## T050 — Implement order state machines
- Admin routes in server.ts reference `database.db` (not a local `db` variable) — the `if (database)` guard narrows the type but doesn't create a local alias in this block; use `database.db` directly
- The `STATUS_COLUMNS` mapping needs an explicit union type (`"status" | "paymentStatus" | ...`) rather than `keyof typeof order.$inferSelect` — otherwise TS complains when indexing a select result that only has a subset of columns
- Keep transition maps as plain `Record<string, string[]>` rather than typed enums — this makes the `isValidOrderTransition` function work with arbitrary string inputs (e.g., from webhook payloads) without requiring casting

## T051 — Implement Stripe webhook handler
- Fastify only allows one content type parser per MIME type — for Stripe webhook signature verification (which requires the raw body), use a `preParsing` route hook to capture the raw buffer and attach it to `request.rawBody`, then return a `Readable.from(rawBody)` so Fastify still parses JSON normally for other middleware
- The `createCheckoutOrder` function used `status: "checked_out"` for the cart, but the DB `ck_cart_status` constraint only allows `active`, `converted`, `abandoned`, `expired` — the correct status is `converted`
- Webhook handlers must be idempotent at every transition: wrap each `transitionOrderStatus()` call in try/catch since the order may already be in the target state (e.g., re-delivered `payment_intent.succeeded` after order is already `confirmed`)

## T052 — Implement refund API (admin)
- Adding a method to `PaymentAdapter` interface requires updating all stub implementations across test files — the TypeScript compiler will catch missing methods but this creates cross-test-file changes
- Use `COALESCE(SUM(...), 0)` when calculating total refunded to handle the case where no refunds exist yet — without COALESCE, the sum returns null which breaks the comparison
- The refund `processRefund` function takes a `createStripeRefund` callback instead of the full adapter — this keeps the query layer decoupled from the adapter interface and makes unit testing easier

## T053 — Implement order cancellation API (admin)
- "Shipped" validation must check multiple shipping statuses beyond just "shipped" — `in_transit`, `out_for_delivery`, `delivered`, `delivery_exception`, and `returned` all indicate the order has left the warehouse
- The cancel function passes the `PaymentAdapter` through the input rather than importing it at the query layer — this follows the existing DI pattern and keeps the query module testable without service-level dependencies
- When an auto-formatter or linter runs on save, it can strip newly added imports if the code using them hasn't been saved yet — always add the import and its usage in the same edit to avoid this race condition

## T054 — Implement policy acknowledgment
- The `policySnapshot` and `orderPolicyAcknowledgment` Drizzle schema tables were already defined in `evidence.ts` — check existing schema files before creating new ones
- Policy acknowledgment in checkout is non-critical — wrap in try/catch so checkout still works when no policies are seeded yet (e.g., fresh dev environments)
- No `POLICIES_READ/WRITE` capability exists yet — policy admin routes reuse `PRODUCTS_READ` / `PRODUCTS_WRITE` capabilities since policies are content management

## T054a — Implement kit cart re-validation on definition change
- Use dynamic `await import("./kit.js")` in `cart.ts`'s `getCartWithItems` to avoid circular dependency — cart.ts imports kit schema types but kit.ts imports cart schema, so runtime dynamic import breaks the cycle
- `getCurrentKitPriceForCartLine` queries `cart_kit_selection` to detect if a line is a kit — this is cheaper than adding a column and avoids schema migration
- Checkout must check `kitWarnings` separately from `staleItems` — a kit can have requirement changes without individual variant price/stock issues, so the `ERR_KIT_VALIDATION_FAILED` error is distinct from `ERR_CART_STALE`

## T054b — Implement reservation expiry / payment race handler
- Move order status confirmation (`pending_payment → confirmed`) AFTER reservation consumption — this allows skipping confirmation when expired reservations can't be re-reserved, keeping the order in `pending_payment` for manual review
- When re-reserving expired inventory, use `reservationReason: "payment_race_recovery"` so the audit trail distinguishes recovery reservations from checkout ones
- The `AdminAlertService` follows the same DI pattern as `LowStockAlertService` — in-memory queue exposed via `ServerInstance`, injectable via `CreateServerOptions` for test access

## T054c — Implement idempotent inventory adjustments
- The `inventory_adjustment` table already had `idempotency_key` column with UNIQUE constraint from the migration — the implementation only needed a pre-check query and race-condition handling (catch `23505` unique violation for concurrent duplicates)
- Accept `idempotency_key` from both header (`idempotency_key` or `idempotency-key`) and body field — HTTP headers are lowercased by Fastify, so `request.headers["idempotency_key"]` works when the client sends `Idempotency_Key`
- Duplicate requests return HTTP 200 (not 201) with the original adjustment result — this signals to the client that no new resource was created while still returning useful data

## T054d — Implement Stripe unreachable checkout error
- The checkout route already had partial Stripe error handling (`StripeConnectionError`, `StripeAPIError`) — expanding it to also catch `StripeTimeoutError` and generic network errors (`ECONNREFUSED`, `ETIMEDOUT`) makes the 502 response more robust
- The reservation release + no-order-created guarantee is inherent in the existing flow — reservations are created first, PaymentIntent is created before `createCheckoutOrder`, so a Stripe failure naturally prevents order creation
- For integration tests, simulating Stripe failure only requires a `PaymentAdapter` stub that throws with `type: "StripeConnectionError"` — duck typing on the error's `type` property means no need to import actual Stripe error classes

## T054e — Implement duplicate email verification conflict detection
- SuperTokens' `verifyEmailPOST` override runs after the email is verified, so duplicate detection must call `EmailVerification.unverifyEmail()` to roll back if a conflict is found — the check-then-reject pattern requires a compensating action
- The `AdminAlertService` must be passed through `SuperTokensConfig` since `initSuperTokens` is a singleton — it captures `config` in the closure, so the service from the first `createServer` call is the one used for all verification attempts
- For integration tests, seeding a customer record directly in the DB (with a fake `authSubject`) simulates an existing account owning the email — SuperTokens prevents duplicate email signups, so you can't create two real accounts with the same email via email/password

## T055 — Critical path checkpoint (Phase 6)
- The Phase 6 critical path test appends to `critical-path.integration.test.ts` alongside Phase 3 and Phase 5 checkpoints — reuse the same `describeWithDb`, `isSuperTokensUp`, `signUpUser`, and `signInAndGetHeaders` helpers already in the file
- Webhook signature generation requires a known secret matching the server config's `STRIPE_WEBHOOK_SECRET` — use a dedicated constant (e.g. `CP6_WEBHOOK_SECRET`) and pass it through `testConfig` override + `generateWebhookPayload`
- After `consumeReservation`, inventory balance `on_hand` decreases by the consumed quantity (not just `reserved`→0 and `available` restored) — verify `on_hand = initial - consumed`, `reserved = 0`, `available = on_hand`

## T056 — Implement fulfillment task system
- The fulfillment_task Drizzle schema and DB migration already existed — only the query layer, state machine logic, admin routes, and integration tests needed to be created
- The `blocked` state in the fulfillment task state machine can transition back to ANY active state (recovery) — model this in the transition map with `blocked: [...ACTIVE_STATES]`
- Auto-creation of fulfillment tasks is wired into `handlePaymentSucceeded` in webhook.ts — wrap in try/catch so fulfillment task creation failures don't block payment confirmation

## T057 — Implement EasyPost adapter
- Extending `ShippingAdapter` interface with new methods requires updating all test file stubs — export `createStubShippingAdapter()` from the adapter module so tests can import it directly instead of defining local copies
- EasyPost `Shipment.buy(shipmentId, rateId)` returns the purchased shipment with `tracking_code`, `postage_label.label_url`, and `tracker.id` — these are the three key fields needed for `BuyLabelResult`
- Stub adapter params that are unused should omit parameter names entirely (matching the existing `calculateRate()` pattern) to avoid `@typescript-eslint/no-unused-vars` lint errors

## T058 — Implement shipment system
- All shipment-related schema tables (shipment, shipment_package, shipment_line, shipment_event, shipping_label_purchase) were already defined in `fulfillment.ts` — only the query layer, state machine, routes, and tests needed to be created
- The `buyShipmentLabel` function takes the `ShippingAdapter` as a parameter (DI pattern) — this allows tests to inject the stub adapter without external API calls, consistent with the pattern used for fulfillment tasks and payment
- Shipment number generation uses `SHP-<orderNumber>-<timestamp_base36>` — sufficient for V1 since each order typically has one shipment, but could collide in high-concurrency scenarios (consider a sequence table later)

## T059 — Implement tracking webhook handler
- Adding a new required Config key (`EASYPOST_WEBHOOK_SECRET`) requires updating ALL test config objects across ~30 test files — use sed/batch replace to add the field consistently, but verify the easypost webhook test's config isn't duplicated
- EasyPost webhook events are routed by `tracking_code` (→ `shipment.trackingNumber`) rather than a separate `trackerId` column — avoids schema migration since tracking number is already stored on shipment from label purchase
- Shipment status doesn't have `out_for_delivery` but order `shipping_status` does — map EasyPost `out_for_delivery` to shipment `in_transit` while propagating the more granular `out_for_delivery` to the order level

## T059a — Implement shipment void-label API
- The `voidLabel` method and `voided` status transitions were already defined in the adapter interface and state machine from T057/T058 — only the query function, route, and tests needed to be created
- Void only calls the adapter when a label was actually purchased (status `label_purchased` or `ready`) — for `draft`/`label_pending` it just transitions to `voided` without adapter interaction
- The refund cost is calculated by summing all `shippingLabelPurchase` records for the shipment — supports future multi-label scenarios

## T059b — Implement shipment refresh-tracking API
- The `trackerId` needed for `adapter.getTracking()` is stored in `shippingLabelPurchase.rawPayloadJson` (the full `BuyLabelResult` object) — extract via `rawPayload.trackerId` rather than adding a new column
- Use deterministic provider event IDs (`refresh-${occurredAt}-${status}`) for idempotency on refresh — this prevents duplicate events when refresh is called multiple times with the same tracking data
- The refresh endpoint reuses `handleTrackingUpdate()` from the webhook handler to propagate status changes to both shipment and order — avoids duplicating the transition logic
