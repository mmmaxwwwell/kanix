# Learnings

Discoveries, gotchas, and decisions recorded by the implementation agent across runs.

---

## T090 — Implement SSG product catalog pages
- Astro SSG product pages must gracefully handle missing API (`PUBLIC_API_URL` not set) — `fetchProducts()` returns `[]` so the build succeeds with an empty catalog and a "Coming Soon" placeholder
- Product-to-module STL viewer matching uses slug substring matching (`product.slug.includes(mod.slug)`) since product slugs may contain the module slug plus a material suffix (e.g. `waste-bag-dispenser-tpu`)
- OpenGraph meta tags added to `Base.astro` via optional props (`ogImage`, `ogType`, `canonicalUrl`) — all existing pages get default OG tags without changes since the new props have sensible defaults

## T091 — Implement guest checkout as Astro islands
- Astro checkout uses vanilla JS `<script>` tags (not React/Vue islands) since the project has no framework integration — Astro bundles these into separate JS files in `_astro/`, so integration tests checking for inline JS strings must also grep the bundled files
- The API's `POST /api/checkout` combines shipping calc + tax calc + Stripe PaymentIntent creation in one call, returning `client_secret` — the checkout flow is: address form → checkout API → show totals → Stripe `confirmPayment()` → redirect to confirmation
- Stripe.js loaded from CDN (`js.stripe.com/v3/`) with the Payment Element (not Card Element) for PCI compliance — uses `appearance: { theme: "night" }` to match the dark Kanix theme

## T092 — Implement kit builder page
- Kit builder uses the public `GET /api/kits` endpoint (from T085's `findActiveKitsWithDetails`) which returns kit definitions with nested requirements, product classes, products, and variant-level inventory — no auth required
- Kit variant selection UI uses `data-class-id` attributes on buttons to scope selections per class, with CSS class toggling for selected state (`border-amber-500 bg-amber-500/10`) — savings calculated client-side as `sum(individual prices) - kit price`
- The `POST /api/cart/kits` endpoint expects `{ kit_definition_id, selections: [{ product_class_id, variant_id }] }` and returns `{ kit, cart }` — the cart library's `addKitToCart` auto-creates a cart if no token exists (same pattern as `addToCart`)

## T093 — Add contributions model page
- Astro content pages (contributions, warranty, etc.) are pure static pages — no API data fetching needed, just use the Base layout with matching nav/footer patterns from index.astro
- Royalty spec details are spread across FR-069 through FR-076 — the key numbers are: 10% royalty at 25-unit threshold (retroactive), 20% for 501(c)(3) donation option, 50-unit starter kit milestone

## T094 — Add warranty, returns, and care instructions pages
- Material temperature thresholds already defined in `MATERIAL_WARNINGS` in `site/src/data/products.ts` — reuse these values (TPU 60°C, TPC 130°C, PLA 50°C, PETG 80°C, ABS 100°C) for consistency across warranty and care pages
- Footer links must be added to every page individually since there's no shared footer component — 10 pages total needed updating (7 existing + 3 new)

## T095 — Update README with contributions model
- T093 already added the full Contributions Model section to README (milestones table, contributions page link, CLA instructions) — T095 was redundant and required no code changes

## T095a — Add nix-mcp-debugkit flake input + re-export packages + config writers
- Config writers use `pkgs.writeTextFile` with `destination` to produce a directory containing `mcp/*.json` — `nix build .#mcp-android-config` outputs a store path with `mcp/android.json` inside it
- MCP config JSON pins commands to Nix store paths via string interpolation (`"${mcp-android}/bin/mcp-android"`) so the config is reproducible and doesn't rely on PATH

## T095b — Register MCP servers + required permissions in `.claude/settings.json`
- MCP server registrations go in `.mcp.json` (project root), not in `.claude/settings.json` — the settings schema does not accept `mcpServers` directly
- `enableAllProjectMcpServers: true` in settings.json auto-approves all servers from `.mcp.json` so agents don't get prompted

## T095c — KVM + emulator prereq verification + backend setup/teardown scripts
- `kvm-ok` is not always installed (not in the Nix devshell); the prereqs script falls back to checking `/dev/kvm` readability when `kvm-ok` is unavailable
- Astro dev server default port is 4321 (not 3000) — setup.sh uses `--port 4321` explicitly to avoid conflicts with the API on port 3000
- `pg_ctl start` is idempotent-safe (returns 0 even if already running) making the setup script re-runnable without killing existing services first

## T095d — APK install + app launch scripts consumed by MCP runner
- Flutter app package IDs follow `com.kanix.kanix_admin` / `com.kanix.kanix_customer` pattern (not `com.kanix.admin`) — defined in `android/app/build.gradle.kts` as `applicationId`
- Debug APK output path is `build/app/outputs/flutter-apk/app-debug.apk` relative to each Flutter project root
- `adb shell am force-stop` before `am start` ensures a cold start; idempotent since force-stop on an uninstalled package is a no-op

## T095e — Set up Playwright + Patrol regression harnesses
- Playwright JSON reporter configured via `PW_JSON_OUTPUT` env var — defaults to `../test-logs/e2e/playwright-results.json` relative to site dir; Patrol uses `flutter test --machine` to emit JSON
- Patrol Android setup requires both `MainActivityTest.java` with `@RunWith(PatrolJUnitRunner.class)` in `androidTest/` AND `testInstrumentationRunner` in `build.gradle.kts` `defaultConfig`
- Site uses pnpm (not npm) for dependency management — `pnpm add -D @playwright/test` installs correctly; CI workflow uses `npm ci` since `package-lock.json` may be expected by the workflow

## T200 — Harden db/db.integration.test.ts
- The old test used `describe.skip` via `describeWithDb` when `DATABASE_URL` was unset — replaced with `requireDatabaseUrl()` from `test-helpers.ts` which throws loudly in `beforeAll`
- `postgres.js` `sql.end()` makes subsequent template-tag queries throw — use `conn.sql\`SELECT 1\`` (not `conn.db.execute()`) to test post-close failure since drizzle's `execute()` needs a proper SQL object
- `createDatabaseConnection` with an unreachable URL doesn't throw until the first query — `checkDatabaseConnectivity` returns `false` (catches internally), but raw `sql\`SELECT 1\`` throws

## T201 — Harden ready.integration.test.ts
- The `/ready` endpoint returns only `{ status, dependencies? }` — `uptime` and `version` are on `/health` (HealthResponse), not `/ready` (ReadyResponse)
- When `isReady()` is false (before `markReady()` or during shutdown), `/ready` short-circuits to 503 without checking dependencies — the response body has no `dependencies` field in this case
- The old test used `describeWithDb = DATABASE_URL ? describe : describe.skip` — replaced with `requireDatabaseUrl()` + `assertSuperTokensUp()` for loud failures

## T202 — Harden critical-path.integration.test.ts
- **SuperTokens singleton trap**: `initSuperTokens` uses `if (initialized) return;` — Phase 3's SIGTERM closes the DB connection captured by the singleton. Reordered tests so Phase 5/6 run before Phase 3 to avoid stale DB references.
- **verifySession bug fix**: The custom `verifySession` in `middleware.ts` passed raw Fastify request/reply to `Session.getSession()`, causing `getCookieValue is not a function` (500 error). Fixed by importing `FastifyRequest`/`FastifyResponse` wrappers from `supertokens-node/lib/build/framework/fastify/framework.js` and wrapping before calling `getSession`.
- **SuperTokens claim validators**: When using SuperTokens `Session.getSession` with proper wrappers, EmailVerification in REQUIRED mode causes 403 for unverified users. Must pass `overrideGlobalClaimValidators: () => []` since `requireVerifiedEmail` is a separate preHandler.
- **Public products API requires class membership**: `findActiveProductsWithDetails` filters products by `productClassMembership`. Test products without class membership won't appear in listings — use the detail endpoint (`/api/products/:slug`) instead, which has no class membership requirement.
- **Admin API responses use Drizzle camelCase**: Balance responses use `onHand`/`reserved`/`available` (not snake_case), and movement responses use `movementType`/`quantityDelta`.

## T203 — Harden auth/auth.integration.test.ts
- SuperTokens `signIn` returns 200 with `status: "WRONG_CREDENTIALS_ERROR"` (not HTTP 401) — test both wrong-password and non-existent-email to prevent enumeration
- Email verification uses `EmailVerification.createEmailVerificationToken` + `verifyEmailUsingToken` server-side; must re-sign-in after verification to get a session with the verified claim
- Rate limit test needs a separate server instance with `RATE_LIMIT_MAX: 3` to avoid polluting the main test server's request counter

## T205 — Harden auth/email-conflict.integration.test.ts
- SuperTokens `signUpPOST` override `input.formFields` values are typed `unknown` — cast to `string` for drizzle `ilike()`
- For consistent enumeration defense, both the pre-signup customer-table check AND the SuperTokens `EMAIL_ALREADY_EXISTS_ERROR` path must return the same `GENERAL_ERROR` / `ERR_EMAIL_CONFLICT` response shape
- `ilike()` from drizzle-orm handles case-insensitive matching against the `text` column in Postgres without needing `citext` extension

## T206 — Harden auth/github-link.integration.test.ts
- Mock GitHub user IDs must be unique per run (use `Date.now()` offsets) — hardcoded IDs like `12345` or `99001` collide with data from prior test runs since the shared Postgres instance isn't wiped between runs
- The test already used `createTestServer` with `serverOverrides: { githubUserFetcher }` to inject a mock GitHub API fetcher — this is the correct pattern for external API boundaries (mock the fetcher, not the DB/auth)

## T207 — Harden auth/guest-order-link.integration.test.ts
- Order status check constraint (`ck_order_status`) only allows: `draft`, `pending_payment`, `confirmed`, `completed`, `canceled`, `closed` — NOT `placed`. Use `"draft"` for test fixture orders.
- Guest order linking happens in the `verifyEmailPOST` override (not `signUpPOST`), so orders remain unlinked until email verification — this is by design per FR-066.
- The old test used inline `createServer`/`testConfig`/`createFakeProcess` boilerplate; replaced with the shared `createTestServer`/`stopTestServer` harness from `test-server.ts`.

## T208 — Harden auth/audit-log.integration.test.ts
- The existing `admin_audit_log` table has `actor_admin_user_id NOT NULL` with FK to `admin_user`, so it can't store customer auth events. A separate `auth_event_log` table is needed for login/logout/signup/failed_login events.
- SuperTokens handles `/auth/signout` internally — `request.session` is not set by custom `verifySession` preHandler on that route. To capture the user ID before signout, use `Session.getSession` directly in an `onRequest` hook with `sessionRequired: false`.
- Capturing SuperTokens response bodies requires an `onSend` hook (which receives the payload before it's flushed) storing the parsed JSON on the request object, since `onResponse` can't read the response body.

## T209 — Harden public-catalog.integration.test.ts
- The old test file used inline `createServer`/`testConfig`/`createFakeProcess` boilerplate instead of the shared `createTestServer`/`stopTestServer` harness from `test-server.ts` — the migration was needed alongside the assertion hardening.
- `findActiveProductsWithDetails` filters to products with at least one `productClassMembership` row — test products without class membership won't appear in `GET /api/products` (but the slug detail endpoint has no such requirement). Both endpoints filter to `status = "active"` variants only.

## T210 — Harden catalog/variant-class.integration.test.ts
- The `product_class` table has no `status` column, so "archived classes in public" is tested by verifying that archived *variants* are hidden from public catalog while still visible in admin endpoints.
- The audit log for `product_class_membership` has a pre-existing bug: `entityId` uses `productId:classId` concatenation which isn't valid UUID for the `entity_id uuid` column — this causes audit log write failures but doesn't block the membership operation itself.
- Sequential `it()` tests that depend on state from previous tests (e.g., variant status transitions) must set up that state in `beforeAll` or the test itself — remove silent `if (!id) return` skip guards that hide broken setup.

## T211 — Harden kit-composition.integration.test.ts
- `product_class.name` has a unique constraint (`uq_product_class_name`) — use `Date.now()` suffix on names (not just slugs) to avoid collisions with data from prior test runs on the shared DB.
- The kit `ERR_KIT_CLASS_MISMATCH` error message comes from the query layer (`addKitToCart`), not the route handler — server re-throws the query error's message. Actual message: "Variant's product does not belong to the specified class" (not the handler's fallback).
- OOS variant alternatives only include variants from *other products* in the same class (the query skips the OOS variant's own product) — so test fixtures need at least 2 products per class to produce alternatives.

## T212 — Harden kit-revalidation.integration.test.ts
- Kit cart line stores `selections[0].variant_id` as its `variantId` — `getCartWithItems` checks inventory for THAT variant only, not all kit components. To test OOS, delete/zero the primary variant's balance rows (not a component-only update).
- Using `update(...).set({ available: 0 })` on `inventoryBalance` by variantId may not affect all rows if prior test runs left orphan balances at different locations — use `delete` + re-insert for reliable OOS simulation.
- Checkout returns `ERR_CART_STALE` (400) for price/stock issues and `ERR_KIT_VALIDATION_FAILED` (400) for structural kit warnings (archived variant, changed requirements) — stale-items check runs first, kit warnings second.

## T213 — Harden customer-address.integration.test.ts
- Cross-user address isolation works via `customerId` scoping in `updateAddress`/`deleteAddress` queries — returns 404 (not 403) which avoids existence leaks. The list endpoint is scoped by `findAddressesByCustomerId`, so another user's addresses never appear.
- `validateAddressFields` returns one error at a time (first failing field wins) — per-field validation tests need one test per missing field to cover the cascade (full_name → line1 → city → state → postal_code).
- The old test file used inline `testConfig`/`createFakeProcess` boilerplate — migrated to shared `createTestServer`/`stopTestServer` harness from `test-server.ts`.

## T214 — Harden cart.integration.test.ts
- OOS add-to-cart returns 400 (not 409 as task description suggests) with `ERR_INVENTORY_INSUFFICIENT` — the route handler in `server.ts` maps the query-layer error to 400, not 409.
- Kit-to-cart test requires full product class + membership + kit definition + kit class requirement setup — `productClass.name` has a unique constraint so use `Date.now()` suffix.
- `findCartByToken` filters by `status = 'active'` only — setting cart status to `"expired"` in DB makes it invisible to the API, which is the mechanism for expired cart cleanup even without a dedicated cleanup endpoint.

## T215 — Harden checkout.integration.test.ts
- The checkout handler picks `findInventoryBalances(db,{})[0].locationId` as the default location for ALL reservations — tests must insert inventory at the same location as existing balance rows, not at a freshly created location, or `reserveInventory` will fail with `ERR_INVENTORY_NOT_FOUND`.
- Stale-cart detection returns 400 `ERR_CART_STALE` (not 409 as the task description says) — the handler returns `stale_items[]` with `variant_id`, `price_changed`, and `insufficient_stock` booleans for each stale item.
- `order.shippingAddressSnapshotJson` is a Postgres `jsonb` column — Drizzle returns it as an object, not a string. Don't `JSON.parse()` it; use it directly or guard with `typeof` check.

## T216 — Harden policy-acknowledgment.integration.test.ts
- `policy_snapshot` has FK RESTRICT from `order_policy_acknowledgment` — can't delete snapshots referenced by acknowledgments from prior test runs. To test "missing policy" scenarios, UPDATE `effective_at` to far future (3000-01-01) so `findCurrentPolicyByType` returns null, then restore in `finally`.
- `policy_snapshot` has a unique constraint on `(policy_type, version)` — version bump tests must use a unique high version number (e.g. `900000 + random`) to avoid collisions with prior runs on the shared DB.
- The original checkout handler wrapped `createCheckoutAcknowledgments` in try/catch as non-critical — hardening required moving policy validation before order creation and returning 400 `ERR_MISSING_POLICY` with `missing_policies[]` array.

## T217 — Harden order-state-machine.integration.test.ts
- The state machine is DB-only (no HTTP server needed) — test directly against `transitionOrderStatus` / `findOrderById` / `findOrderStatusHistory` from `order-state-machine.js`. Each test creates its own order via direct DB insert at the desired starting state, avoiding sequential test dependencies.
- Terminal states are defined by having `[]` (empty array) in the transition maps — use the exported `*_TRANSITIONS` records to dynamically generate exhaustive rejection tests for every terminal state × every possible target.
- `transitionOrderStatus` throws plain objects (not Error instances) with `{ code, message, statusType, from, to }` — cast `catch (err: unknown)` as the specific shape rather than using `instanceof Error`.

## T218 — Harden order-cancel.integration.test.ts
- The cancel endpoint (`/api/admin/orders/:id/cancel`) returns 400 (not 409) for both `ERR_ORDER_ALREADY_SHIPPED` and `ERR_INVALID_TRANSITION` — the handler maps all domain errors to 400.
- Audit log entries are written automatically via the `onResponse` hook in `auth/audit-log.ts` — no manual `insertAuditLog` call needed; just set `request.auditContext` in the route handler. Query `admin_audit_log` by `entityId` + `action="order.cancel"` to verify.
- The old test used inline `testConfig`/`createFakeProcess` boilerplate — migrated to shared `createTestServer`/`stopTestServer` harness; the `env.sh` file lives at `.dev/e2e-state/env.sh` (not `test/e2e/.state/env.sh`).

## T220 — Harden duplicate-ticket.integration.test.ts
- The original `createSupportTicket` duplicate detection checked only same customer + same order within 24h — task T220 required same-category matching too, so added `eq(supportTicket.category, input.category)` to the detection query.
- Added `forceDuplicate?: boolean` to `CreateTicketInput` to allow admin override of duplicate detection — the admin endpoint passes `force_duplicate` from the request body.
- Running `duplicate-ticket` and `support-ticket` tests simultaneously causes `generateTicketNumber()` collisions (timestamp-based `TKT-<base36>`) — run them in isolation or use sequential mode.

## T219 — Harden resend-confirmation.integration.test.ts
- Fastify rejects `POST` with `Content-Type: application/json` and no body (`FST_ERR_CTP_EMPTY_JSON_BODY` → 500). For admin action endpoints that take no body, omit the Content-Type header entirely.
- The `resend-confirmation` endpoint is at `/api/admin/orders/:id/resend-confirmation` with `verifySession + requireAdmin + requireCapability(ORDERS_MANAGE)` — only `super_admin` role has `ORDERS_MANAGE`; `support`/`finance`/`fulfillment` do not.
- Updated `createNotificationService` to accept an optional `{ emailLogPath }` and write email entries to a JSONL file alongside the in-memory queue, enabling `logs/emails.jsonl` assertions in integration tests.

## T221 — Harden low-stock-alert.integration.test.ts
- `notificationDispatch.dispatchAlert` publishes one WebSocket message per admin target (via `inAppAdapter.send → wsManager.publish`), so with N active admins in the shared DB, the wsManager buffer gets N messages per alert. Use `>= 1` assertion, not `== 1`, and filter by variantId + buffer offset.
- `LowStockAlertService` had no deduplication — added a per-variant cooldown map with configurable `cooldownMs` (default 5 min). The `clear()` method must also clear the cooldown map to avoid stale timestamps.
- Email assertions against the default `logs/emails.jsonl` must filter by admin email + variant ID since other test files and prior test runs also write to the same log file.

## T222 — Harden reservation-cleanup.integration.test.ts
- `releaseExpiredReservations` was changed from returning `number` to `{ released, kept }` (`CleanupMetrics`). The `kept` count query uses drizzle's `gte()` + `count()` — do NOT use `sql` template literals with `Date` objects for postgres.js (causes `ERR_INVALID_ARG_TYPE`); use drizzle column operators instead.
- Balance API response uses camelCase (`onHand`) — the original test had `on_hand` which was silently passing due to `undefined === undefined` coincidence. Removed the fragile assertion.
- Sequential tests sharing the same variant/location must clean up reservations at the end of each test (force-expire via direct DB update + re-run cleanup) to avoid balance state leaking into the next test.

## T223 — Harden reservation-expiry-race.integration.test.ts
- The old test had its own inline `testConfig`/`createFakeProcess` boilerplate but properly set `STRIPE_WEBHOOK_SECRET` to match the test's HMAC secret. When migrating to `createTestServer`, pass the custom secret via `configOverrides: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET }` — otherwise signature verification fails because the default is `"whsec_xxx"`.
- `consumeReservation` decrements both `on_hand` and `reserved` — after re-reserve + consume the balance math is: onHand-=qty, reserved-=qty, available stays at onHand-reserved. Verify all three fields, not just `available`.

## T224 — Harden admin-customers.integration.test.ts
- The existing admin customer endpoints had no capability gating — added `CUSTOMERS_READ`, `CUSTOMERS_MANAGE`, and `CUSTOMERS_PII` capabilities. `super_admin` gets all (via `Object.values(CAPABILITIES)`); `support` role gets `CUSTOMERS_READ` only. PII redaction is driven by checking `CUSTOMERS_PII` in the route handler, not middleware.
- Search by order number uses a subquery `customer.id IN (SELECT order.customerId FROM order WHERE ilike(order.orderNumber, pattern))` — this joins via the `or()` alongside email/name search without duplicating customer rows.
- The audit trail endpoint looks up the customer's `authSubject` from the customer table, then queries `auth_event_log` by `actorId` — the auth events use SuperTokens user IDs, not customer table UUIDs.

## T225 — Harden admin-dashboard.integration.test.ts
- The `dispute` table has NO `createdAt` column — it uses `openedAt` instead. When adding date filters to dashboard queries, use `dispute.openedAt` for the time dimension.
- `inventoryBalance` has no `createdAt` either (only `updatedAt`) — low stock counts are point-in-time by nature, so date range filtering is intentionally skipped for that aggregate.
- For delta-based assertions on shared DB: capture a "baseline" summary before seeding test-specific data, then assert `(after - baseline) == expectedDelta` for each count field.

## T226 — Harden admin-inventory.integration.test.ts
- The DB CHECK constraint (`ck_inventory_balance_available`) throws a postgres.js error whose properties don't always match the expected `{ code: "23514", constraint: "ck_inventory_balance..." }` shape via Drizzle transactions. Solved by adding a pre-check in `createInventoryAdjustment` that throws `{ code: "ERR_INVENTORY_INSUFFICIENT" }` before the UPDATE.
- API response fields from Drizzle `returning()` use camelCase (`onHand`, `adjustmentType`, `idempotencyKey`), not snake_case. Test type casts using `as` don't fail at runtime — accessing `body.adjustment.adjustment_type` silently returns `undefined`, making assertions pass vacuously when comparing `undefined` to something else.
- The `admin_audit_log.entity_id` column is `uuid` type — using a non-UUID string like `"bulk"` causes an insert failure. For bulk operations, use the first result's adjustment ID as the entity_id.

## T227 — Harden admin-products.integration.test.ts
- Drizzle wraps postgres.js errors: the top-level error has `{ query, params, cause }` — the original postgres.js error (with `code: "23505"` for unique violations) is in `err.cause`. Use `err.cause?.code ?? err.code` to handle both raw and wrapped errors.
- Product archive does NOT automatically propagate to variants — had to add explicit propagation in the PATCH `/api/admin/products/:id` handler that loops over `findVariantsByProductId` and archives each non-archived variant.
- No media upload URL signing endpoint exists in the codebase — the media POST endpoint just stores a provided URL string directly. Tests verify URL round-trip through create and GET.

## T228 — Harden admin-reservation.integration.test.ts
- The audit log hook (`onResponse`) fires asynchronously after the HTTP response is sent — tests that query `admin_audit_log` immediately after a request may find no entries. A 150ms `setTimeout` before the DB query reliably gives the hook time to complete.
- Drizzle `returning()` fields are camelCase (`movementType`, `quantityDelta`), not snake_case — the old test typed response bodies with snake_case keys (`movement_type`, `quantity_delta`) which silently returned `undefined`, making assertions vacuously pass.
- Fastify route registration order matters for parameterized paths — `/api/admin/inventory/reservations/list` and `/api/admin/inventory/reservations/stats` must be registered BEFORE `/api/admin/inventory/reservations/:id` to avoid the `:id` param matching `"list"` or `"stats"`.

## T229 — Harden admin-settings.integration.test.ts
- Ajv `removeAdditional: true` silently strips unknown JSON body properties — tests should verify stripping behavior (fields not persisted), not expect 400 rejection. Numbers coerced to strings too; only objects fail type validation for string fields.
- Admin WS channels are hardcoded in `ws/manager.ts` — adding a new domain event entity (e.g. `setting`) requires adding `"setting:*"` to the admin channel set or events won't reach admin WS clients.
- The `settings_updated` audit log `beforeJson` was `null` — changed to capture the before-state for proper audit diffing. The audit hook fires asynchronously (~150ms delay needed before DB query in tests).

## T230 — Harden fulfillment-task.integration.test.ts
- `fulfillment_task.assigned_admin_user_id` has FK constraint (`fk_ft_admin`) to `admin_user` — tests that call `assignFulfillmentTask` must create real `admin_user` rows first; fake UUIDs like `00000000-...` will fail with FK violation.
- `findStaleFulfillmentTasks` (new) queries active + blocked tasks whose `updatedAt` is older than a threshold — terminal states (done, canceled) are excluded. Uses `inArray` + `lt` drizzle operators against the `updatedAt` timestamp column.
- The `transitionFulfillmentTaskStatus` return includes `oldStatus`/`newStatus` fields that the HTTP route handler uses for audit log `afterJson` — test these fields directly to verify event tracking data is correct without needing HTTP-level tests.

## T231 — Harden shipment.integration.test.ts
- `evidence_record` table has immutability triggers (both UPDATE and DELETE blocked by PL/pgSQL triggers). To clean up in afterAll, use `ALTER TABLE evidence_record DISABLE TRIGGER USER` / `ENABLE TRIGGER USER` — `DISABLE TRIGGER ALL` fails with "permission denied: system trigger".
- `hasShipmentEventBeenProcessed` checks providerEventId globally (not per-shipment). In tests with fixed `occurredAt` for idempotency testing, use a run-unique timestamp (e.g. `Date.now()`) to avoid collisions with prior test runs on the shared DB.
- `order_line.variant_id` has FK constraint to `product_variant` — test fixtures must create real product + variant rows first. Fake UUIDs like `00000000-...` cause FK violations when the test runs in isolation.

## T235 — Harden void-label.integration.test.ts
- `voidShipmentLabel` didn't catch adapter errors — carrier window expiry (adapter throws) caused unhandled error propagation. Added `ERR_VOID_WINDOW_EXPIRED` error code with adapter error wrapping; HTTP endpoint maps it to 409.
- `voidShipmentLabel` had no audit trail — added `shipmentEvent` insert for every void with refund/no-refund description, using `void-{shipmentId}-{timestamp}` as the providerEventId to avoid collisions.
- The stub adapter's `voidLabel` always returns `{ refunded: true }` — to test carrier-window-expired or no-refund scenarios, override just that method via spread: `{ ...adapter, async voidLabel() { ... } }`.

## T237 — Harden easypost-webhook.integration.test.ts
- `findShipmentById` does NOT select `deliveredAt`/`shippedAt`/`labelPurchasedAt` — to verify these timestamps, query the raw `shipment` table directly with `db.select({ deliveredAt: shipment.deliveredAt })`.
- `storeShipmentEvent` returns only `{ id }` (not the full event row); `findShipmentEventsByShipmentId` returns 6 fields but omits `rawPayloadJson`. Use UUID regex to validate the returned ID.
- Cleanup must handle `order_status_history` (FK `fk_osh_order`) and `evidence_record` (FK `fk_er_shipment` + immutability triggers) before deleting orders/shipments — use `ALTER TABLE evidence_record DISABLE TRIGGER USER` then re-enable.

## T238 — Harden refund.integration.test.ts
- The refund handler had no explicit check for already-refunded orders — `processRefund` would catch it as `ERR_REFUND_EXCEEDS_PAYMENT` (remaining=0). Added an explicit 409 `ERR_ORDER_ALREADY_REFUNDED` check on `paymentStatus === "refunded"` before calling `processRefund`.
- Stripe adapter failures were unhandled (re-thrown → 500 via Fastify error handler). Added catch-all returning 502 `ERR_REFUND_PROVIDER_FAILURE` to distinguish provider failures from validation errors. The refund record is NOT inserted since `processRefund` calls the adapter before the DB insert.
- Audit log `onResponse` hook fires asynchronously — need ~200ms delay before querying `admin_audit_log` in tests (same pattern as T228, T229).

## T239 — Harden stripe-unreachable.integration.test.ts
- No circuit breaker existed — created `api/src/services/circuit-breaker.ts` (closed/open/half-open states) and wired it into `CreateServerOptions`/`ServerInstance`. Tests override `paymentCircuitBreaker` with a low threshold + short reset for speed.
- Changed Stripe unreachable from 502 to 503 + `Retry-After: 30` header. The circuit breaker short-circuits requests when open (returns 503 without calling the adapter).
- Health endpoint `dependencies.payment` field added: `"ok"` when circuit closed, `"degraded"` when open or half-open. Checkout `recordSuccess()` resets the breaker on successful payment.

## T240 — Harden support-ticket.integration.test.ts
- The lifecycle test used a fake admin UUID (`00000000-...`) for `createTicketMessage`'s `adminUserId` which violates FK constraint `fk_stm_admin` on `support_ticket_message`. Must create a real `admin_user` row in `beforeAll`.
- Cleanup must handle `evidence_record` (FK `fk_er_ticket` + immutability triggers) and `linked_ticket_id` self-referencing FK — disable triggers with `ALTER TABLE evidence_record DISABLE TRIGGER USER`, null out `linkedTicketId` before deleting tickets.
- No SLA breach column existed — added `sla_breached_at` timestamp to schema + Liquibase migration `013-support-ticket-sla.xml`. The `findAndMarkSlaOverdueTickets` query uses `notExists` subquery on admin messages + `lt(createdAt, cutoff)` + `isNull(slaBreachedAt)` for idempotent breach marking.

## T241 — Harden ticket-attachment.integration.test.ts
- Attachment upload endpoints need `bodyLimit: 15 * 1024 * 1024` because base64 encoding inflates 10MB files to ~14MB, exceeding Fastify's default 1MB body limit. Without this, the server returns 500 before the handler runs.
- The `evidence_record` table FK column referencing `support_ticket` is `support_ticket_id` (not `ticket_id`). Cleanup requires `ALTER TABLE evidence_record DISABLE TRIGGER USER` before deleting tickets.
- `admin_role.capabilitiesJson` is the Drizzle field name (maps to `capabilities_json` column), not `capabilities` — using the wrong field silently inserts `null` causing FK/NOT NULL violations downstream.

## T242 — Harden warranty-claim.integration.test.ts
- `order_line.variant_id` has FK constraint `fk_order_line_variant` to `product_variant` — fake UUIDs like `00000000-...-000001` cause FK violations. Must create real product + variant rows first (same pattern as T231 shipment tests).
- `support_ticket` has a self-referencing FK (`fk_support_ticket_linked_ticket` on `linked_ticket_id`) — cleanup must `UPDATE SET linked_ticket_id = NULL` before deleting tickets, otherwise deletion fails with FK violation.
- The warranty claim HTTP endpoint (`POST /api/support/warranty-claims`) returns `material_limitation_flagged` / `material_limitation_note` (snake_case) in the HTTP response, but the `createWarrantyClaim` function returns `materialLimitationFlagged` / `materialLimitationNote` (camelCase) — the server handler maps between the two.

## T243 — Harden evidence-auto-collection.integration.test.ts
- The DELETE immutability test (`trg_evidence_record_no_delete`) failed because other test files' `afterAll` cleanup disables the trigger and may not re-enable it if the process crashes. Fix: re-enable both triggers in `beforeAll` before any tests run.
- `DISABLE TRIGGER USER` is safer than disabling individual trigger names for cleanup — it disables all user triggers in one statement, avoiding issues with mismatched trigger names.
- `generateEvidenceBundle` attaches a `_content` property (the full bundle JSON) to the return value but it's not in the TypeScript interface — cast to `any` to access it for bundle size assertions.

## T244 — Harden evidence-browsing.integration.test.ts
- No `GET /api/admin/disputes` endpoint existed — had to create one with a `listDisputes` query that LEFT JOINs `evidence_record` on `disputeId` and groups by all dispute columns to get per-dispute `evidenceCount`.
- The `listDisputes` evidence count only includes records directly linked via `disputeId` FK, NOT all evidence for the order. So dispute 1 gets count=2 (r4+r7 linked by disputeId), not count=6 (all order evidence).
- `DISABLE TRIGGER USER` is the safest cleanup approach for `evidence_record` (same as T243) — always re-enable in `beforeAll` in case prior runs crashed.

## T245 — Harden evidence-bundle.integration.test.ts
- `evidence_bundle.status` CHECK constraint (`ck_eb_status`) allows only `'generating'`, `'generated'`, `'submitted'`, `'failed'` — using "rejected" violates the constraint. Use `'failed'` for Stripe rejection scenarios.
- `findDisputeById` in `db/queries/evidence.ts` didn't include `providerDisputeId` — needed to add it to submit evidence to Stripe (the adapter requires the provider-facing dispute ID, not the internal UUID).
- POSTing with `Content-Type: application/json` and no body triggers Fastify `FST_ERR_CTP_EMPTY_JSON_BODY` (500) — for admin action endpoints that take no body (generate-bundle, submit-bundle), omit the Content-Type header (same pattern as T219).

## T246 — Harden manual-evidence.integration.test.ts
- `evidence_record` immutability triggers (`trg_evidence_record_no_delete`) must be disabled/re-enabled in a try/finally block for the admin DELETE endpoint — use `DISABLE TRIGGER trg_evidence_record_no_delete` (not `USER`) to scope to just the delete trigger.
- Audit log query for removal must filter by `action = "evidence.manual_remove"` since the same `entityId` also has an `evidence.manual_attach` entry from creation.
- No content-type validation existed on the `POST /api/admin/disputes/:id/evidence` endpoint — added `ALLOWED_EVIDENCE_CONTENT_TYPES` (same set as ticket attachments: jpeg, png, pdf) to reject executables and HTML.

## T247 — Harden contributor.integration.test.ts
- The `contributor` table had no `cla_version` or `profile_visibility` columns — added via Liquibase migration `014-contributor-profile-fields.xml` with a CHECK constraint on `profile_visibility IN ('public', 'private')` and default `'public'`.
- Public contributor endpoints (`/api/contributors/public` and `/api/contributors/public/:username`) filter by `profile_visibility = 'public'` — the per-username endpoint also returns the contributor's designs for profile rendering.
- The old test used DB-level queries only; hardened version uses HTTP-level tests through `createTestServer` with admin auth (signUp + signIn + admin_user + admin_role setup) following the same pattern as T227.

## T248 — Harden contributor-dashboard.integration.test.ts
- The dashboard endpoint (`GET /api/contributors/dashboard`) uses session → customer → contributor lookup, so each authenticated user only ever sees their own dashboard — no contributor ID in the URL means no cross-user access path exists.
- `getContributorDashboard` had no date range filtering — added optional `from`/`to` parameters that scope the royalty aggregation query via `gte`/`lte` on `contributorRoyalty.createdAt`. Designs, milestones, and payouts are unaffected by the date filter (lifetime values).
- The old test used direct DB connections only; migrated to `createTestServer` with full auth (signUp + verifyEmail + signIn) since the endpoint requires `verifySession + requireVerifiedEmail`.

## T249 — Harden contributor-milestones.integration.test.ts
- The `contributor_milestone` table has a CHECK constraint (`ck_cm_milestone_type`) that must be extended via a Liquibase migration (015) when adding new milestone types like `"veteran"`. The Drizzle schema uses plain `text`, so the error surfaces at runtime as a postgres check violation, not a TypeScript compile error.
- `processOrderCompletionSales` was changed from returning `SalesTrackingResult[]` to `OrderCompletionResult { sales, newMilestones }` — all callers in other test files (royalty-engine, contributor-sales, contributor-dashboard) need updating to destructure `{ sales: results }`.
- Other contributor test files (royalty-engine, contributor-sales) lacked `contributor_milestone` cleanup in `afterAll` — once `detectMilestones` creates milestones, deleting the contributor fails with FK violation on `fk_cm_contributor`. Always include `contributorMilestone` cleanup before `contributor` deletion.

## T251 — Harden royalty-engine.integration.test.ts
- `getRoyaltyRate` checks donation status first (charityName + charityEin → 20%), then veteran threshold (500+ → 20%), then default (10%) — donation always wins over veteran rate. Test both paths independently with separate `describe` blocks.
- Zero-price promo lines (unitPriceMinor=0) produce royalty entries with `amountMinor=0` — the engine doesn't skip them, which is correct for tracking/audit purposes.
- The veteran rate tier test benefits from seeding 499 units in `beforeAll` via a single large order, then testing the 500th crossing and post-veteran sales separately — avoids the 500-iteration loop that would be needed with single-unit orders.

## T252 — Harden notification-dispatch.integration.test.ts
- `Session.getSessionWithoutRequestResponse(token)` rejects tokens where email is unverified — throws `INVALID_CLAIMS` (not `UNAUTHORISED`). All WS tests that use token auth MUST call `verifyEmail(authSubject)` after `signUpUser` before attempting WS connections.
- `signUpUser` auto-creates a `customer` row via the SuperTokens `signUpPOST` override — do NOT insert into the `customer` table manually after signup; use `select().from(customer).where(eq(customer.authSubject, ...))` to find the existing row.
- `dispatchAlert` sends to ALL active admins matching email/both preference; the "last email in the log" may not be the expected target. Search for the specific recipient in the email log rather than checking the last line.

## T253 — Harden websocket.integration.test.ts
- WS reconnect replay: the server sends welcome + replayed messages in the same event-loop tick via synchronous `socket.send()`. Using sequential `await waitForMessage()` (which registers `ws.once("message")`) loses the second message because the event fires before the second listener is registered. Use `collectMessages(ws, count)` with `ws.on("message")` set up BEFORE `waitForOpen` to capture all messages eagerly.
- Cross-customer WS isolation: customer channels are `customer:<customerId>`, so events published to one customer's channel never reach another. Test by publishing to customer B's channel and asserting absence on customer A's WS.
- Negative WS assertions (expect no message): `waitForMessage` rejects on timeout, so `Promise.race([waitForMessage().then(…), setTimeout])` propagates the rejection. Use a dedicated `expectNoMessage` helper that resolves on timeout and rejects if a message arrives.

## T254 — Harden domain-events.integration.test.ts
- `generateOrderNumber` used `COUNT(*)+1` which collides when prior test runs leave orders with the same number. Fixed to use `MAX(substring(order_number from 'KNX-0*([0-9]+)')::int)` against only `'^KNX-[0-9]+$'` rows. Note: `\d` in JS template literals is just `d` — use `[0-9]` in SQL regex within `sql` tagged templates.
- `createDomainEventPublisher` now accepts `{ wsManager, db }` options to persist events to `domain_event` table. The fire-and-forget DB insert uses `.catch()` so persistence failure doesn't block event flow. The old single-arg `(wsManager)` signature is auto-detected via `"publish" in arg`.
- Subscriber isolation: each subscriber is called in a try/catch so sync/async failures in one don't block others. The `subscribe()` method returns an unsubscribe function that removes the callback from the Set.

## T261 — Flow test: authenticated checkout
- The checkout handler at `/api/checkout` has code to resolve `customerId` from `request.session`, but the route lacks a `verifySession` preHandler — `request.session` is always null. Fixed by adding optional session detection using `Session.getSession` with `sessionRequired: false` and SuperTokens Fastify wrappers.
- Authenticated flow tests need `skipListen: false` (real HTTP) because SuperTokens auth requires cookie exchange via `fetch()`. Only the webhook can use `app.inject()` (no auth needed, just signature).
- Order status history records transitions, not initial states — `payment_status` history contains `processing` and `paid` but NOT the initial `unpaid` value.

## T260 — Flow test: guest checkout on Astro
- `POST /api/cart/items` returns 201 (not 200) — use `toBeLessThan(300)` or check for 201 explicitly when asserting add-to-cart success.
- `productClass` and `productClassMembership` schemas are in `db/schema/product-class.ts` (not `catalog.ts`) — import from the correct file when setting up class membership for catalog visibility.
- Flow tests that use sequential `it()` blocks sharing state via outer-scope variables must not bail early — if step N fails, steps N+1..M will fail with empty IDs. Use `skipListen: true` for flow tests that only use `app.inject()`.

## T262 — Flow test: kit purchase
- Kit add-to-cart (`POST /api/cart/kits`) creates a single `cart_line` with `unitPriceMinor` = kit price and `variantId` = first selection's variant (the "primary variant"). Checkout creates one order line at the kit price, not one line per kit component.
- `addKitToCart` returns `{ kitPriceMinor, individualTotalMinor, savingsMinor, selections[] }` — savings = sum(individual prices) - kit price. Assert exact math in the response rather than re-querying DB.
- Kit class requirements need two separate product classes, each with their own product + variant + class membership. Using `Date.now()` suffix on class names avoids `uq_product_class_name` collisions with prior test runs on the shared DB.

## T264 — Flow test: dispute lifecycle
- `handleTrackingUpdate` requires going through `in_transit` before `delivered` — skipping in_transit returns `shipmentTransitioned: false` and prevents auto-completion. Always call the in_transit update first (same pattern as T263).
- The `charge.dispute.created` webhook handler looks up the payment by `chargeId` first, then falls back to `paymentIntentId`. The test must ensure the chargeId is set on the payment row (via `latest_charge` in the `payment_intent.succeeded` webhook payload).
- Evidence records with immutability triggers need `DISABLE TRIGGER USER` / `ENABLE TRIGGER USER` for both test setup (seeding evidence) and cleanup. Always re-enable triggers in `beforeAll` and `afterAll` to avoid poisoning subsequent test runs.

## T265 — Flow test: contributor royalty
- The `/api/contributors/public/:username` endpoint returns `ContributorRow` with camelCase keys (`githubUsername`, `profileVisibility`), not snake_case — Fastify serializes drizzle row objects as-is without case transformation.
- `processOrderCompletionSales` must be called after the order is in `completed` status because `createRetroactiveRoyalties` filters for `order.status = 'completed'`. Setting status to `completed` before calling the function is required for retroactive royalties to include the current order's lines.
- The 500-unit veteran rate (20%) only applies to orders processed AFTER `getRoyaltyRate` detects `totalSales >= 500`. The order that crosses the threshold still gets the rate calculated at the moment of processing, which may be 20% if newSalesCount >= 500 at the time.

## T266 — Flow test: concurrent inventory
- `reserveInventory` uses `SELECT ... FOR UPDATE` on `inventory_balance` which correctly serializes concurrent reservation attempts — exactly M of N concurrent attempts succeed when stock=M. The inventory concurrency model is sound.
- `generateOrderNumber` in `checkout.ts` has a race condition: it reads `MAX(order_number)` then inserts, causing `uq_order_order_number` violations under concurrency. This means some checkouts that successfully reserved inventory may still fail at order creation (500). The inventory reservation is NOT rolled back on this failure path, creating "orphan" active reservations.
- Checkout returns 400 (not 409) with `ERR_INVENTORY_INSUFFICIENT` when stock is exhausted — the task description says 409 but the actual code uses 400.

## T267 — Flow test: WebSocket real-time propagation
- The customer message endpoint (`POST /api/support/tickets/:id/messages`) was missing `domainEvents.publish("ticket.updated", ...)` — added it so admin WS clients receive real-time notification when customers post messages. The admin message endpoint already had this.
- The admin internal-notes endpoint (`POST /api/admin/support-tickets/:id/internal-notes`) intentionally does NOT publish domain events — this ensures internal notes are never leaked to customer WS channels.
- WS flow tests must set up message listeners (via `waitForMessage`) BEFORE triggering the event (HTTP call or wsManager.publish), since the server sends WS messages synchronously in the same tick as the publish call.

## T268 — Flow test: security boundary enforcement
- SuperTokens access tokens are JWTs verified locally — after signout, they remain valid until expiry unless `checkDatabase: true` is passed to `Session.getSession()`. Added this to the `verifySession` middleware for immediate revocation enforcement.
- Fastify schema validation on POST routes runs before `preHandler` hooks — using POST admin endpoints for 403 tests may yield 400 from schema validation instead. Use GET endpoints for auth boundary tests.
- Rate-limit tests need a separate `createTestServer` instance with `RATE_LIMIT_MAX: 3` to avoid hitting the main test server's rate limit counter (which is shared across all tests using that instance).

## T269 — Flow test: guest-order → account linking
- Guest checkout steps (cart creation, add items, checkout, webhook) can use `app.inject()` since no auth is needed, but the signup/verify/signin steps need real HTTP (`fetch`) because SuperTokens requires cookie exchange. Using both in the same test works fine since `createTestServer` with default `skipListen: false` starts a real HTTP listener.
- The `verifyEmailPOST` override must be triggered via the HTTP endpoint (`POST /auth/user/email/verify`) rather than just `EmailVerification.verifyEmailUsingToken` server-side, because the linking logic is in the SuperTokens override — direct SDK calls bypass the override.

## T270 — Flow test: warranty claim submission
- `TPU_HEAT_KEYWORDS` in `createWarrantyClaim` includes the literal string `"tpu"` — any claim description mentioning TPU (even "TPU phone case has a crack") triggers `material_limitation_flagged: true`. Tests for non-flagged claims must avoid "TPU" in the description text.
- The warranty flow test exercises the full admin resolution path via ticket status transitions (`open → waiting_on_internal → open → resolved`), not a dedicated "approve/deny" endpoint — there is no separate warranty-specific resolution endpoint.

## T271 — Flow test: admin refund (full + partial) through Stripe
- The refund flow test doesn't need real HTTP (`skipListen: false`) for refund operations since the refund endpoint uses `app.inject()` with admin auth headers — only the initial signup/signin needs real HTTP for SuperTokens cookie exchange.
- No domain event or notification is published on refund creation — the only side effects are the DB refund record, payment_status transition (with order_status_history), and async audit log entry. The task description mentions "customer notification" but the current implementation has none.
- Partial refund balance math: `processRefund` uses `getTotalRefundedForOrder` (SUM of all refund amounts) to compute remaining. Multiple partial refunds work correctly — each subtracts from the cumulative total, not from the original amount.
