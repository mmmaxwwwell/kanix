# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T039 — Implement product variant + classification API (admin)
- Variant status transitions follow a strict state machine (draft→active→inactive→archived, with archived terminal) — use a `VARIANT_STATUS_TRANSITIONS` map and validate before applying, keeping the guard logic (SKU + price required for activation) in the route handler
- `onConflictDoNothing().returning()` returns an empty array on conflict — when assigning product-to-class membership, fetch the existing row if the insert returns nothing to maintain idempotent behavior
- Keep variant and product-class queries in separate files (`variant.ts`, `product-class.ts`) rather than adding to the growing `product.ts` — each query module stays focused and the barrel export in `index.ts` unifies them

## T038 — Implement product CRUD API (admin)
- Product status state machine (`draft→active`, `active→draft`, `draft→archived`, `active→archived`; archived is terminal) is enforced in the route handler via `isValidProductTransition()` — keep the transition map in the query module alongside the data access functions
- Drizzle's `sql` template tag works well for compound WHERE conditions on composite-key tables like `collection_product` — use `sql\`col1 = ${val1} AND col2 = ${val2}\`` instead of chaining multiple `.where()` calls
- When T039 runs in parallel and commits server.ts changes, ensure your route additions (media, collections) are present — Fastify route registration order matters for param-based routes (`:id` must come after fixed paths like `/reorder`)

## T040 — Implement inventory balance + adjustment API (admin)
- `inventoryBalance` has a UNIQUE(variant_id, location_id) constraint — use `onConflictDoNothing()` for upsert, then fetch existing row if insert returns nothing (same pattern as T039 for product-class membership)
- PostgreSQL CHECK constraint `ck_inventory_balance_available CHECK (available >= 0)` enforces non-negative inventory — catch error code `23514` with constraint name containing `ck_inventory_balance` to return a clean `ERR_INVENTORY_INSUFFICIENT` response
- Use `sql` template for atomic column updates (`on_hand + delta`, `available + delta`) rather than reading, computing, and writing — avoids race conditions and lets the DB enforce constraints in a single statement

## T041 — Implement inventory reservation system
- Use raw `tx.execute(sql\`SELECT ... FOR UPDATE\`)` for row-level locking in Drizzle — the ORM's query builder doesn't support `FOR UPDATE` natively, but raw SQL in a transaction works correctly for pessimistic concurrency control
- When `consume()` and `release()` read from raw SQL results, column names come back as snake_case (`variant_id`, `location_id`) not camelCase — cast them accordingly when accessing fields from `tx.execute()` results
- The reservation goes directly to `active` status on creation (skipping `pending`) because the balance lock + available check + balance update all happen atomically in the same transaction — no separate "confirm" step is needed

## T042 — Implement reservation cleanup cron
- `releaseExpiredReservations()` was already implemented in T041's `reservation.ts` — T042 only needed a `setInterval` wrapper with logging and shutdown registration
- Use `timer.unref()` on the cleanup interval so Node can exit cleanly even if the timer is still active — otherwise the process hangs during tests and graceful shutdown
- Pass `reservationCleanupIntervalMs: 0` in `CreateServerOptions` to disable the cron in integration tests that call `releaseExpiredReservations()` directly

## T043 — Implement low-stock alert
- The adjustment flow already returns a `lowStock` boolean from `createInventoryAdjustment()`, so the alert trigger piggybacks on that flag — no extra DB query needed for adjustments
- For reservations, `reserveInventory()` doesn't return the updated balance — call `findBalanceByVariantAndLocation()` after to check `available < safetyStock` and trigger the alert
- The `LowStockAlertService` uses an in-memory queue exposed via `ServerInstance.lowStockAlertService` — tests access it directly to verify alerts were queued without needing a notification backend

## T044 — Implement public catalog API
- Public catalog routes go in server.ts without any auth middleware — they're just `app.get("/api/products", ...)` inside the `if (database)` guard, placed before the shutdown manager section
- Inventory availability for the public API is computed by summing `inventoryBalance.available` across all locations per variant — for V1 there's only one location, but the query handles multiple
- The `adminUser` schema uses `name` (not `displayName`) — check the actual Drizzle schema column names before writing test setup code

## T045 — Implement customer address CRUD API
- Customer address routes use the same auth pattern as `/api/customer/me` — `verifySession` + `requireVerifiedEmail` preHandlers, then resolve customer via `getCustomerByAuthSubject`
- The `is_default` only-one-default constraint is enforced in application code (not DB) — `insertAddress` and `updateAddress` unset existing defaults of the same `type` before setting the new one
- Address API uses snake_case in request body (`full_name`, `postal_code`, `is_default`) but camelCase in DB/Drizzle schema — the route handler maps between them

## T045a — Critical path checkpoint (Phase 5)
- Wrap `beforeAll` setup in try/catch and set `superTokensAvailable = false` on failure — this prevents `beforeAll` errors from marking the suite as FAIL when SuperTokens is unavailable or version-incompatible
- The `isSuperTokensUp()` check only verifies `/hello` responds, but version incompatibility causes signup to fail at runtime — the try/catch is necessary for graceful degradation

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
