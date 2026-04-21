# Tasks: Kanix Commerce Platform

**Approach**: Fix-validate loop. Each phase: build → test → lint → security scan → read test-logs/ failures → fix code → re-run until green.

**Non-Goals**: See spec.md § Non-Goals. Do NOT implement: custom orders, colors, subscriptions, marketplace, international shipping, manufacturing integration, live chat, cloud sync, or plugin system.

---

## Phase 1: Repo Restructure + Nix Flakes [FR-098, FR-099]

- [x] T001 Create root flake.nix composing all sub-flakes [FR-098]
  Done when: `nix flake check` passes; `nix develop` enters shell with nodejs_22, pnpm, flutter, opentofu, liquibase, postgresql, process-compose, openscad, trivy, semgrep, gitleaks; `.envrc` auto-activates via direnv

- [x] T002 Reorganize scad/ with its own flake.nix [FR-098]
  Done when: `scad/flake.nix` provides openscad-unstable + BOSL2; existing SCAD files compile; root flake includes scad as input; `scripts/test-scad.sh` still passes

- [x] T003 Update site/ with its own flake.nix [FR-098]
  Done when: `site/flake.nix` provides nodejs_22 + pnpm; `cd site && nix develop && pnpm install && pnpm build` works; root flake includes site as input

- [x] T004 Create api/ project skeleton with flake.nix [FR-098]
  Done when: `api/flake.nix` provides nodejs_22, pnpm, liquibase, jdk21_headless, postgresql_16; `api/package.json` has all scripts; `api/tsconfig.json` has strict mode; pnpm install succeeds

- [x] T005 Create admin/ and customer/ Flutter project skeletons with flake.nix [FR-098]
  Done when: `admin/flake.nix` and `customer/flake.nix` provide flutter SDK; `flutter create` scaffold exists; `flutter test` runs (empty)

- [x] T006 Create deploy/ with flake.nix for infrastructure tooling [FR-098]
  Done when: `deploy/flake.nix` provides opentofu, nginx; `deploy/tofu/` and `deploy/nixos/` directories exist with placeholder files

- [x] T007 Create process-compose.yml for dev services [FR-099]
  Done when: `process-compose up` starts Postgres on port 5432 and SuperTokens on port 3567; `pg_isready` confirms Postgres is up; health check confirms SuperTokens is up

- [x] T008 Create .env.example with all environment variables [FR-112]
  Done when: .env.example lists every config key from spec (DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_TAX_ENABLED, SUPERTOKENS_API_KEY, SUPERTOKENS_CONNECTION_URI, EASYPOST_API_KEY, GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, LOG_LEVEL, PORT) with placeholder values and comments

- [x] T009 Update .gitignore for all new directories
  Done when: .gitignore covers: .direnv/, result, node_modules/, dist/, .dart_tool/, build/, .flutter-plugins*, .env, .env.local, *.pem, *.key, credentials.json, test-logs/, coverage/

---

## Phase 2: Test Infrastructure + Foundational Backend [FR-100, FR-103, FR-104, FR-105, FR-106, FR-107, FR-108, FR-109, FR-110, FR-111, FR-112, FR-113, FR-114]

- [x] T010 Initialize api/ with pnpm, TypeScript strict, Vitest, ESLint + Prettier [FR-100]
  Done when: `pnpm install --ignore-scripts` succeeds; `pnpm typecheck` passes; `pnpm lint` passes; `pnpm test` runs Vitest (no tests yet); `pnpm build` produces dist/

- [x] T011 Implement Vitest custom reporter for structured test output [FR-100]
  Done when: Vitest outputs JSON results to `test-logs/test-results.json`; reporter includes test name, status, duration, error message for failures; aggregatable by CI summary script

- [x] T012 Implement api/src/config.ts — single config module [FR-112, FR-113, FR-114]
  Done when: config loads from defaults → .env file → env vars; fail-fast validation on startup logs every missing/invalid key and exits non-zero; secrets (DATABASE_URL, STRIPE_SECRET_KEY, etc.) only from env vars; sensitive values never appear in logs ("present"/"missing" only); STRIPE_TAX_ENABLED flag controls tax adapter selection; unit tests cover: valid config, missing required, invalid type, sensitive redaction

- [x] T013 Implement api/src/errors.ts — typed error hierarchy [FR-105]
  Done when: AppError base class with subclasses: ValidationError (400), NotFoundError (404), ConflictError (409), AuthenticationError (401), AuthorizationError (403), ExternalServiceError (502), RateLimitError (429), InternalError (500); each has errorCode (e.g., ERR_ORDER_NOT_FOUND), HTTP status, userFacing flag; unit tests verify all mappings

- [x] T014 Implement api/src/logger.ts — Pino structured logging [FR-104]
  Done when: Pino configured with structured JSON to stderr; 5 levels (DEBUG/INFO/WARN/ERROR/FATAL); LOG_LEVEL configurable via config module; correlation ID generated per request via Fastify hook and attached to all log entries; unit test verifies JSON output format with timestamp, level, message, module, correlationId fields

- [x] T015 Implement api/src/shutdown.ts — graceful shutdown [FR-106]
  Done when: SIGTERM/SIGINT handlers registered; shutdown sequence: log "Shutdown initiated" → stop accepting connections → mark /ready as 503 → drain in-flight → close WebSocket → close DB pool → close externals → flush logs → exit 0; 30s timeout with force exit 1; shutdown hook registry (reverse order); unit test verifies sequence logging

- [x] T016 Implement Fastify server skeleton with health endpoints [FR-103]
  Done when: Fastify server boots on configured PORT; `GET /health` returns 200 with `{status, uptime, version, ready, dependencies}`; `GET /ready` returns 503 during startup (no DB), 200 when ready; JSON response matches spec format; integration test verifies both endpoints

- [x] T017 Implement security middleware: CORS, rate limiting, security headers [FR-108, FR-109, FR-110]
  Done when: CORS rejects requests from non-allowed origins (returns 403, not wildcard); rate limiter returns 429 with Retry-After header and X-RateLimit-Limit/Remaining/Reset headers; security headers present on every response: Strict-Transport-Security, Content-Security-Policy, X-Content-Type-Options=nosniff, X-Frame-Options=DENY, Referrer-Policy=strict-origin-when-cross-origin; integration tests verify each header and rate limit behavior

- [x] T018 Implement JSON schema validation plugin [FR-107]
  Done when: Fastify JSON schema validation rejects invalid request bodies with 400 status; response includes `{error: "validation_failed", details: [{field, message}]}`; extra fields are stripped; integration test covers: missing required field, wrong type, extra fields

- [x] T019 Implement global error handler [FR-105]
  Done when: Fastify error handler catches all errors at boundary; AppError subclasses return correct HTTP status + error code; unknown errors return 500 with generic message (no stack leak); all errors logged with correlationId, errorCode, stack; integration test covers: ValidationError→400, NotFoundError→404, unknown Error→500

- [x] T020 Set up CI workflow: lint, typecheck, test, security scan [FR-111] [P]
  Done when: `.github/workflows/api-ci.yml` runs on push/PR; stages: pnpm install → lint → typecheck → test → trivy fs → semgrep → gitleaks detect → npm audit; SARIF uploads to GitHub Security tab for trivy + semgrep + gitleaks; security-events: write permission; workflow passes on clean codebase

- [x] T021 Create security scanner script for local fix-validate loop [FR-111] [P]
  Done when: `scripts/security-scan.sh` runs trivy, semgrep, gitleaks, npm audit with JSON output to `test-logs/security/`; produces `test-logs/security/summary.json` with per-scanner findings count and pass/fail; script exits non-zero if any critical findings

- [x] T022 Create CLAUDE.md development section [FR-099]
  Done when: CLAUDE.md includes: quick start (nix develop → pnpm dev), available scripts table, environment setup (.env.example → .env), project structure overview, UI_FLOW.md instructions, test commands for all languages/platforms

- [x] T023 Smoke test: server boots and responds [FR-103]
  Done when: integration test starts Fastify server, verifies /health returns 200, /ready returns 503 (no DB), server shuts down cleanly on SIGTERM

---

## Phase 3: Database + Migrations [FR-032, FR-033, FR-101] [consumes: IC-001]

- [x] T024 Configure Postgres in process-compose and deploy/nixos [FR-101]
  Done when: `process-compose up` starts Postgres; `pg_isready` confirms connectivity; `deploy/nixos/postgres.nix` module configures Postgres 16 with auth, logging, backup settings

- [x] T025 Set up Liquibase with changelog structure [FR-101] [produces: IC-001]
  Done when: `api/migrations/changelog-master.xml` exists; `api/migrations/changesets/` directory with initial changeset; `pnpm db:migrate` runs Liquibase update; `pnpm db:rollback` runs Liquibase rollbackCount; Liquibase tracks applied changesets in databasechangelog table

- [x] T026 Create initial migration: all core entities from data-model.md [FR-032, FR-033]
  Done when: changeset creates all tables from data-model.md; CHECK constraints: `available >= 0`, `reserved >= 0`, `on_hand >= 0`, `price_minor > 0`; unique constraints: `(variant_id, location_id)` on inventory_balance, `order_number` on order, `sku` on product_variant, `slug` on product; FK constraints with RESTRICT; migration runs clean against empty DB; rollback drops all tables

- [x] T027 Set up Drizzle ORM with schema introspection [FR-032] [consumes: IC-001]
  Done when: Drizzle schema files in `api/src/db/schema/` reflect all tables from migration; typed queries in `api/src/db/queries/`; `SELECT 1` query succeeds via Drizzle; integration test: insert and read a product row with type safety

- [x] T028 Create seed script with dev data [FR-101]
  Done when: `pnpm db:seed` populates: 5 products with TPU/PA11/TPC variants, product classes (plates/modules/belts), kit definition (starter kit), inventory balances (50 units each), 1 admin user (super_admin role), 1 inventory location (default warehouse); seed is idempotent (safe to run multiple times); `pnpm db:reset` drops + recreates + migrates + seeds

- [x] T029 Update /ready to check Postgres connectivity [FR-103]
  Done when: `GET /ready` returns 200 when Postgres is connected; returns 503 with `{dependencies: {database: "down"}}` when Postgres is unreachable; integration test verifies both states

- [x] T030 Critical path checkpoint (Phase 3) [Critical Path]
  Done when: integration test verifies: server boots → /health 200 → /ready 200 (DB connected) → seed data queryable via Drizzle → server shuts down cleanly

---

## Phase 4: Auth + Admin Identity [FR-064, FR-065, FR-066, FR-068, FR-077, FR-078, FR-079, FR-080]

- [x] T031 Configure SuperTokens in process-compose and deploy/nixos [FR-064]
  Done when: `process-compose up` starts SuperTokens core on port 3567; health check confirms SuperTokens is up; `deploy/nixos/supertokens.nix` configures SuperTokens core with Postgres backend

- [x] T032 Implement customer auth: email/password + email verification [FR-064, FR-065]
  Done when: SuperTokens email/password recipe configured; signup creates customer record; email verification required (unverified users get 403 on protected endpoints); login returns session tokens; integration tests: signup → verify email → login → access protected endpoint; unverified user blocked

- [x] T033 Implement GitHub OAuth: link GitHub account [FR-068] [produces: IC-002]
  Done when: SuperTokens social login recipe configured for GitHub; "Link GitHub Account" endpoint associates GitHub user_id with customer record; integration test: create customer → link GitHub → verify github_user_id stored; duplicate link prevented

- [x] T034 Implement admin auth + capability-based permissions [FR-077, FR-078, FR-080] [produces: IC-003]
  Done when: admin auth via separate SuperTokens recipe; admin_role and admin_user_role tables populated from seed; `requireCapability('orders.read')` middleware checks admin's role capabilities; 403 returned for insufficient permissions; integration tests: admin login → has permission → allowed; admin without permission → 403; permission matrix matches spec (orders.read, orders.refund, orders.cancel, inventory.read, inventory.adjust, etc.)

- [x] T035 Implement admin_audit_log middleware [FR-079]
  Done when: Fastify hook on admin routes auto-creates audit_log entries with: actor_admin_user_id, action, entity_type, entity_id, before_json, after_json, ip_address, created_at; integration test: admin creates a product → audit log entry exists with correct before (null) and after (product JSON)

- [x] T036 Implement guest order → account linking [FR-066]
  Done when: on email verification, query orders by `order.email` column (where customer_id IS NULL) and set customer_id to the new account; integration test: create 3 guest orders with email `jane@example.com` → create account with same email → verify email → all 3 orders appear in customer's order list; orders now have customer_id set

- [x] T037 Update /ready to check SuperTokens connectivity [FR-103]
  Done when: /ready checks SuperTokens health endpoint; returns 503 if SuperTokens is down; integration test verifies

---

## Phase 5: Catalog + Inventory [FR-001 through FR-006, FR-032 through FR-038]

- [x] T038 Implement product CRUD API (admin) [FR-001, FR-004, FR-005] [P]
  Done when: POST/GET/PATCH /admin/products; status transitions validated (draft→active→archived, archived is terminal); product media upload with sort_order and alt_text; collection CRUD with product-collection associations; permission check: `products.write` for mutations, `products.read` for reads; integration tests cover: create draft → activate → archive; media reorder; collection management

- [x] T039 Implement product variant + classification API (admin) [FR-002, FR-003] [P]
  Done when: POST/PATCH /admin/products/:id/variants; variants have material axis (TPU/PA11/TPC), independent price_minor, sku, weight, dimensions; product_class CRUD; product_class_membership assignment; integration tests: create product → add TPU variant ($29.99) → add PA11 variant ($49.99) → assign to class "modules"; variant status transitions (draft→active→inactive→archived)

- [x] T040 Implement inventory balance + adjustment API (admin) [FR-032, FR-033, FR-037, FR-038]
  Done when: GET /admin/inventory/balances with filters; POST /admin/inventory/adjustments with adjustment_type (restock/shrinkage/damage), quantity_delta, reason, notes; adjustment atomically updates on_hand and available; audit log entry created with actor; low-stock detection: when available < safety_stock, flag variant; inventory_movement ledger entry created for every adjustment; integration tests: restock +100 → verify balance; shrinkage -5 → verify; CHECK constraint prevents negative available

- [x] T041 Implement inventory reservation system [FR-034, FR-035, FR-036]
  Done when: `inventoryService.reserve(variantId, locationId, quantity, ttl)` atomically increments reserved and decrements available using `SELECT ... FOR UPDATE`; `inventoryService.consume(reservationId)` decrements on_hand and reserved; `inventoryService.release(reservationId)` decrements reserved and increments available; reservation status machine: pending→active→consumed/released/expired; inventory_movement created for each operation; integration tests: reserve → consume; reserve → release; reserve → expire (TTL); concurrent reserve for last unit (one succeeds, one fails with ERR_INVENTORY_INSUFFICIENT)

- [x] T042 Implement reservation cleanup cron [FR-034]
  Done when: cron job (configurable interval, default 1 min) finds reservations with status=active and expires_at < now(); releases each back to available; logs at INFO: "Released N expired reservations"; integration test: create reservation with 1s TTL → wait → verify released

- [x] T043 Implement low-stock alert [FR-038]
  Done when: when inventory adjustment or reservation causes available < safety_stock, notification queued; alert includes variant SKU, product title, available count, safety_stock threshold; integration test: set safety_stock=10 → adjust available to 5 → verify alert queued

- [x] T044 Implement public catalog API (no auth) [FR-001, FR-002] [produces: IC-009]
  Done when: GET /api/products returns active products with variants, media, pricing, availability; GET /api/products/:slug returns product detail with variant availability; response shape matches spec section 4; no auth required; products with status != active are excluded; integration tests: list products (only active), product detail with variants, out-of-stock variant flagged

- [x] T045 Implement customer address CRUD API [FR-067]
  Done when: POST/GET/PATCH/DELETE /api/customer/addresses; addresses linked to customer_id; `is_default` flag with only-one-default constraint; US-only validation on address fields; integration tests: create address → set as default → update → delete; non-US address rejected

- [x] T045a Critical path checkpoint (Phase 5) [Critical Path]
  Done when: integration test exercises: seed data → list products via public API → check inventory → reserve variant → release reservation → verify balance restored

---

## Phase 6: Cart + Checkout + Payments [FR-007 through FR-018, FR-019 through FR-031, FR-117 through FR-120]

- [x] T046 Implement cart API [FR-012, FR-013, FR-014] [produces: IC-010]
  Done when: POST /api/cart (creates guest cart, returns `cart.token` UUID — distinct from `cart.id` PK for security); POST /api/cart/items (add variant, validate availability); DELETE /api/cart/items/:id; GET /api/cart (returns items with current prices + availability); guest carts looked up by `token` column via `X-Cart-Token` header; authenticated carts linked to customer_id; cart validates inventory on read (stale items flagged); integration tests: create guest cart → add items → verify totals; add out-of-stock item → rejected

- [x] T047 Implement kit composition system [FR-007, FR-008, FR-009, FR-010, FR-011]
  Done when: kit_definition, kit_class_requirement, cart_kit_selection entities; POST /api/cart/kits (add kit to cart with selected variants per class); validation: all class requirements satisfied, all selected variants in stock and match class membership; kit price_minor stored on kit_definition (admin-set fixed price); UI shows savings vs individual; inventory reservation per component; integration tests: valid kit → added; incomplete kit → rejected with message "Select 2 more from Plates"; out-of-stock component → rejected with swap suggestion

- [x] T048 Implement Stripe Tax adapter [FR-117, FR-118, FR-119, FR-120]
  Done when: `taxAdapter.calculate(lineItems, shippingAddress)` returns tax amount; production mode: calls Stripe Tax API when STRIPE_TAX_ENABLED=true and valid key; stub mode: returns 0 tax when STRIPE_TAX_ENABLED=false; tax included in Stripe PaymentIntent metadata; integration tests: (stub mode) tax = 0; (if Stripe test key available) tax calculated for TX address

- [x] T049 Implement checkout flow [FR-012, FR-015, FR-016, FR-017, FR-018, FR-022, FR-023, FR-025, FR-026]
  Done when: POST /api/checkout: validates cart → creates inventory reservations (15 min TTL) → calculates shipping via EasyPost → calculates tax via Stripe Tax → creates Stripe PaymentIntent → creates order with status=pending_payment, payment_status=unpaid, `email` field set from checkout input → returns PaymentIntent client_secret; order_number generated as KNX-000001 format; order stores address snapshots + product/price snapshots on order_lines; US-only address validation (non-US → 400); integration tests: full checkout → order created with snapshots + email stored; non-US address rejected; inventory reserved

- [x] T050 Implement order state machines [FR-019, FR-020, FR-021]
  Done when: four orthogonal state machines on order: status (draft→pending_payment→confirmed→completed→canceled→closed), payment_status, fulfillment_status, shipping_status; invalid transitions rejected with ERR_INVALID_TRANSITION; all transitions create order_status_history entry with actor/reason; unit tests: every valid transition succeeds; every invalid transition rejected; integration test: full order lifecycle

- [x] T051 Implement Stripe webhook handler [FR-027, FR-028, FR-029, FR-031] [consumes: IC-004]
  Done when: POST /webhooks/stripe validates signature; idempotent: duplicate event processing is no-op (check payment_event.provider_event_id); handles: payment_intent.succeeded → payment_status=paid + reservation consumed; payment_intent.payment_failed → payment_status=failed + reservation released; charge.refunded → payment_status updated; charge.dispute.created → dispute record created; raw payload stored as payment_event; integration tests: success webhook → order confirmed; duplicate webhook → no-op; invalid signature → 401

- [x] T052 Implement refund API (admin) [FR-030] [P]
  Done when: POST /admin/orders/:id/refunds with amount + reason; validates amount <= remaining refundable; creates Stripe refund; updates payment_status (paid→partially_refunded or refunded); audit log with actor; integration tests: full refund; partial refund; over-refund rejected with ERR_REFUND_EXCEEDS_PAYMENT

- [x] T053 Implement order cancellation API (admin) [FR-024] [P]
  Done when: POST /admin/orders/:id/cancel with reason; validates: not shipped (ERR_ORDER_ALREADY_SHIPPED); releases inventory reservations; initiates full refund if paid; order.status → canceled; audit log; integration tests: cancel unpaid → reservations released; cancel paid → refund + reservations released; cancel shipped → rejected

- [x] T054 Implement policy acknowledgment [FR-062, FR-063]
  Done when: checkout captures policy_snapshot_id for current warranty/returns/terms policies; order_policy_acknowledgment created linking order to policy version; policy_snapshot table with versioned content_html/content_text; integration test: checkout → acknowledgment record exists with correct policy version

- [x] T054a Implement kit cart re-validation on definition change [FR-E005, FR-E006]
  Done when: when admin updates a kit_definition (class requirements or price), any active carts containing that kit are flagged; on next cart read, kit selections are re-validated against new definition; invalid selections show warning to customer; kit price recalculated at checkout from current kit_definition.price_minor (not cached); integration tests: add kit to cart → admin changes class requirement → cart read shows validation warning; price change reflected at checkout

- [x] T054b Implement reservation expiry / payment race handler [FR-E008]
  Done when: when payment_intent.succeeded webhook fires and the order's reservations have been expired by the cleanup cron, the system either (a) re-reserves if stock is still available and confirms the order, or (b) flags the order for manual review with status=`pending_payment` and an admin alert; integration test: create reservation → force-expire it → fire payment success webhook → verify order flagged for review OR re-reserved

- [x] T054c Implement idempotent inventory adjustments [FR-E009]
  Done when: POST /admin/inventory/adjustments accepts optional `idempotency_key` header; duplicate requests with the same key return the original result without creating a second adjustment; integration test: submit adjustment with key → submit same key again → verify only one adjustment record exists

- [x] T054d Implement Stripe unreachable checkout error [FR-E012]
  Done when: when Stripe API is unreachable during PaymentIntent creation, checkout returns 502 with ERR_EXTERNAL_SERVICE_UNAVAILABLE and does NOT create an order; inventory reservations are released; integration test: mock Stripe timeout → verify 502 response + no order + reservations released

- [x] T054e Implement duplicate email verification conflict detection [FR-E017]
  Done when: if a second account attempts to verify an email that is already verified by another account, verification is rejected with ERR_EMAIL_ALREADY_CLAIMED; admin alert created; integration test: account A verifies email → account B attempts to verify same email → rejected

- [x] T055 Critical path checkpoint (Phase 6) [Critical Path]
  Done when: integration test exercises full checkout: seed products → create cart → add items → checkout → Stripe payment succeeds (test mode) → order confirmed → inventory consumed → snapshots stored → policy acknowledged

---

## Phase 7: Fulfillment + Shipping [FR-039 through FR-049]

- [x] T056 Implement fulfillment task system [FR-039, FR-040, FR-041, FR-042, FR-042a]
  Done when: fulfillment_task auto-created when order.payment_status → paid; state machine: new→assigned→picking→picked→packing→packed→shipment_pending→done; blocked state for exceptions; assignment API with admin_user_id; validation: cannot start until payment_status=paid; next-day SLA: orders confirmed before configurable cutoff (default 2:00 PM local) get priority=`high` and flag `sla_at_risk` on dashboard; integration tests: payment succeeds → task created; walk task through full lifecycle; invalid transitions rejected; order before cutoff → high priority; order after cutoff → normal priority

- [x] T057 Implement EasyPost adapter [FR-043, FR-049] [produces: IC-006]
  Done when: `shippingAdapter.getRates(fromAddress, toAddress, packages)` returns carrier rates; `shippingAdapter.buyLabel(rateId)` purchases label and returns tracking number + label URL; `shippingAdapter.getTracking(trackerId)` returns tracking status; adapter interface allows provider swap via config; integration tests (EasyPost test mode): get rates → buy label → verify tracking number returned

- [x] T058 Implement shipment system [FR-044, FR-046, FR-047, FR-048]
  Done when: POST /admin/shipments creates draft shipment for order; shipment_package with weight/dimensions; shipment_line maps order_lines to shipment with quantities; POST /admin/shipments/:id/buy-label purchases via EasyPost adapter and records cost in shipping_label_purchase; shipment status machine: draft→label_pending→label_purchased→ready→shipped→in_transit→delivered; integration tests: create shipment → buy label → mark shipped

- [x] T059 Implement tracking webhook handler [FR-045, FR-046] [consumes: IC-006]
  Done when: POST /webhooks/easypost processes tracking events; creates shipment_event records with status/description/occurred_at/raw_payload; updates shipment.status based on event; propagates to order.shipping_status; integration test: simulate tracking events → shipment status updates → order shipping_status updates

- [x] T059a Implement shipment void-label API [FR-E027] [P]
  Done when: POST /admin/shipments/:id/void-label voids the label via EasyPost adapter; shipment.status → `voided`; refunds label cost if applicable; only valid for pre-ship statuses (draft, label_pending, label_purchased, ready); integration test: buy label → void → verify status=voided; attempt void on shipped → rejected

- [x] T059b Implement shipment refresh-tracking API [P]
  Done when: POST /admin/shipments/:id/refresh-tracking fetches latest tracking from EasyPost adapter; creates any new shipment_event records not already stored; updates shipment.status if changed; integration test: shipped shipment → refresh → new events stored

- [x] T059c Implement shipment mark-shipped API [P]
  Done when: POST /admin/shipments/:id/mark-shipped transitions shipment.status → `shipped`; records shipped_at timestamp; only valid from `ready` status; integration test: ready shipment → mark-shipped → status=shipped + shipped_at set

- [x] T059d Implement order resend-confirmation API [P]
  Done when: POST /admin/orders/:id/resend-confirmation queues order confirmation notification (via notification service / email stub); rate-limited to prevent spam (max 1 per 5 minutes per order); integration test: resend → email logged to stub; rapid resend → rate limited

- [x] T060 Implement fulfillment → shipping status propagation [FR-039, FR-044]
  Done when: when all shipment_lines for an order are in shipped/delivered shipments, order.fulfillment_status → fulfilled; when all shipments delivered, order.shipping_status → delivered; when fulfillment_status=fulfilled AND shipping_status=delivered, order.status can transition to completed; integration test: complete fulfillment → all shipped → delivered → order completable

---

## Phase 8: Support + Disputes + Evidence [FR-050 through FR-063]

- [x] T061 Implement support ticket system [FR-050, FR-051, FR-052, FR-054]
  Done when: POST /api/support/tickets (customer) and POST /admin/support/tickets (admin); state machine: open→waiting_on_customer/waiting_on_internal→resolved→closed; message threading: POST /support/tickets/:id/messages (customer-visible) and POST /admin/support/tickets/:id/internal-notes (admin-only, is_internal_note=true); tickets linkable to order_id, shipment_id; integration tests: customer creates ticket → admin replies → internal note (not visible to customer) → resolve → close

- [x] T061a Implement duplicate ticket detection [FR-E028]
  Done when: when a customer creates a ticket for an order that already has an open/waiting ticket from the same customer within 24 hours, the new ticket is created but flagged with `potential_duplicate=true` and linked to the existing ticket; admin sees flag in ticket queue; admin can merge or dismiss; integration test: create ticket for order → create second ticket for same order within 24h → second ticket flagged; tickets >24h apart → no flag

- [x] T062 Implement ticket attachments [FR-053]
  Done when: POST /support/tickets/:id/attachments accepts JPEG/PNG/PDF up to 10MB, max 5 per message; stored via storage adapter (local filesystem dev, S3 prod); file access controlled: only ticket customer + admins; integration tests: upload valid file → accessible; upload invalid type → rejected; unauthorized access → 403

- [x] T063 Implement warranty claim flow [FR-055]
  Done when: POST /api/support/warranty-claims with order_id, order_line_id, description; validates: order delivered, within 1-year warranty period (from delivered_at); creates support_ticket with category=warranty_claim, priority=high; if TPU heat deformation described, flags material limitation in response; integration tests: valid claim (11 months) → ticket created; expired claim (13 months) → rejected; TPU heat claim → flagged

- [x] T064 Implement dispute auto-creation [FR-056, FR-057]
  Done when: charge.dispute.created webhook creates dispute record; payment_status → disputed; dispute state machine: opened→evidence_gathering→ready_to_submit→submitted→won/lost/accepted→closed; charge.dispute.closed webhook updates dispute outcome and payment_status (won → paid, lost → refunded); integration tests: dispute webhook → record created + payment_status=disputed; close webhook → status updated

- [x] T065 Implement evidence auto-collection [FR-058, FR-059, FR-062]
  Done when: on shipment tracking event → evidence_record (type=`tracking_history`); on shipment delivery confirmation → evidence_record (type=`delivery_proof`); on support_ticket_message creation → evidence_record (type=`customer_communication`); on payment_event creation → evidence_record (type=`payment_receipt`); on order_policy_acknowledgment creation → evidence_record (type=`policy_acceptance`); evidence_record table: no UPDATE/DELETE grants for app user (immutability enforced at DB level); integration test: complete order lifecycle → verify all 5 evidence types created; attempt UPDATE on evidence_record → fails

- [x] T066 Implement evidence bundle generation [FR-060, FR-061]
  Done when: POST /admin/disputes/:id/generate-bundle compiles all evidence_record entries for the dispute's order into a downloadable package; dispute_readiness_summary computed: `tracking_history_present`, `delivery_proof_present`, `customer_communication_present`, `policy_acceptance_present`, `payment_receipt_present`; bundle cannot be generated if readiness is incomplete (missing types flagged); integration tests: complete evidence → bundle generated; incomplete evidence → readiness summary shows gaps

---

- [x] T066a Implement manual evidence attachment API
  Done when: POST /admin/disputes/:id/evidence allows admin to attach manual evidence (file upload or text); creates evidence_record with admin-specified type; file stored via storage adapter; integration test: upload manual evidence → record created; accessible via GET /admin/evidence/:id

- [x] T066b Implement evidence browsing API
  Done when: GET /admin/evidence with filters (type, order_id, shipment_id, ticket_id, dispute_id); GET /admin/evidence/:id returns single record with download URL for file-based evidence; integration tests: filter by order → returns all evidence for that order; filter by type → returns matching records

- [x] T066c Implement fulfillment edge case handling [FR-E013, FR-E023, FR-E024]
  Done when: fulfillment_task.status `blocked` transition available from any active state with required `reason` field; unblock transitions back to previous active state; if inventory discrepancy found during picking, admin can block task and trigger inventory adjustment; if task canceled after picking, auto-create inventory adjustment to return picked items to available stock; integration tests: picking → blocked (reason: missing_inventory) → adjustment → unblock → picking; cancel after picking → verify auto-adjustment returns items to available

- [x] T066d Implement shipping edge cases [FR-E025, FR-E026, FR-E027]
  Done when: EasyPost label purchase failure returns clear error and shipment remains in `label_pending`; delivery_exception shipment_event creates admin alert; exception → in_transit recovery transition supported; void-label refunds/credits label cost if applicable; integration tests: simulate label failure → verify error + no status change; delivery exception → alert fired; exception recovery; void → cost credited

---

## Phase 9: Contributor / Royalty System [FR-069 through FR-076]

- [x] T067 Implement contributor registry + design linking [FR-069, FR-070]
  Done when: contributor entity with github_username, github_user_id, customer_id (nullable), cla_accepted_at; contributor_design links contributor to product; POST /admin/contributors (create from CLA bot data); GET /admin/contributors/:id/designs; integration test: create contributor → link to product → verify association

- [x] T068 Implement per-design sales tracking [FR-070]
  Done when: on order completion (order.status → completed), for each order_line, find contributor_design by product_id; increment sales count; create contributor_royalty entry with status=accrued if contributor has crossed 25-unit threshold; integration test: complete order with contributor-designed product → sales count incremented

- [x] T069 Implement royalty calculation engine [FR-071, FR-072, FR-076]
  Done when: when a contributor's cumulative sales for a design cross 25 units, royalty entries are created retroactively for units 1-25 at 10% of unit_price_minor; subsequent sales auto-create royalty entries; 501(c)(3) donation option at 2x rate (20%) with charity_name and charity_ein; refund clawback: contributor_royalty status → clawed_back; integration tests: 25th sale triggers retroactive royalty for 1-25; 26th sale creates single royalty; refund → clawback; donation at 20%

- [x] T070 Implement milestone tracking + tax documents [FR-073, FR-074]
  Done when: contributor_milestone tracks: accepted_pr, royalty_activation (25 units), starter_kit (50 units); milestones auto-detected on sales; tax document upload: POST /api/contributors/tax-documents with W-9/W-8BEN file; storage via adapter; approval workflow (admin reviews); payout blocked until tax doc approved; integration tests: milestone progression; tax doc upload + approval; payout blocked without approved doc

- [x] T071 Implement contributor dashboard API [FR-075]
  Done when: GET /api/contributors/dashboard (requires linked GitHub account) returns: designs contributed, per-design sales counts, royalty accrual (total, paid, pending), milestone progress, payout history; integration test: contributor with 30 sales → dashboard shows correct totals

---

## Phase 10: Notifications + Real-Time [FR-081 through FR-087]

- [x] T071a Implement admin dashboard summary API
  Done when: GET /admin/dashboard/summary returns `{ordersAwaitingFulfillment, openSupportTickets, lowStockVariants, openDisputes, shipmentsWithExceptions}`; counts computed from current DB state; GET /admin/dashboard/alerts returns actionable alerts (expiring reservations, disputes nearing due_by, cert expiry warnings); integration tests: seed data with known counts → verify summary matches

- [x] T071b Implement admin customer detail APIs
  Done when: GET /admin/customers with search/filter; GET /admin/customers/:id returns profile + stats; GET /admin/customers/:id/orders returns customer's orders; GET /admin/customers/:id/tickets returns customer's tickets; integration tests: create customer with orders and tickets → verify all sub-resource endpoints return correct data

- [x] T071c Implement admin settings APIs [P]
  Done when: GET /admin/settings/shipping returns shipping config (default carrier, service levels, label settings); PATCH /admin/settings/shipping updates config; permission: `admin.settings.manage`; integration test: read → update → read → verify change persisted

- [x] T072 Implement WebSocket server with auth [FR-081, FR-082, FR-083] [produces: IC-008]
  Done when: @fastify/websocket configured; WebSocket upgrade validates token (admin session, customer session, or cart token); authenticated connections subscribe to relevant entity channels; message format: `{type, entity, entityId, data, sequenceId}`; automatic reconnection guidance (client uses exponential backoff); integration tests: admin connects → receives events; unauthenticated → rejected; guest with cart token → receives cart/order events only

- [x] T073 Implement server-side message buffering [FR-083]
  Done when: server buffers messages per connection for up to 5 minutes on disconnect; on reconnect, client sends lastSequenceId; server replays missed messages; integration test: connect → receive message (seq 1) → disconnect → new message sent (seq 2) → reconnect with lastSequenceId=1 → receive seq 2

- [x] T074 Implement pub/sub for domain events [FR-081, FR-082]
  Done when: domain events (order.placed, payment.succeeded, shipment.delivered, ticket.updated, inventory.low_stock, dispute.opened) publish to WebSocket subscribers; admin gets all events; customer gets events for their orders/tickets; integration test: admin connected → create order → admin receives order.placed event within 2 seconds

- [x] T075 Implement notification service + email stub [FR-084, FR-085, FR-086, FR-087]
  Done when: notification service dispatches via adapters: email (stubbed — logs to file), push (stubbed), in-app (via WebSocket); email adapter interface: `send(to, subject, body, templateId)`; stub writes to `logs/emails.jsonl`; admin alert preferences: per-admin config for push/email/both; integration test: trigger low-stock alert → admin with email preference → email logged to file; admin with push preference → WebSocket message received

---

## Phase 11: Flutter Admin App Shell [Admin route map]

- [x] T076 Initialize Flutter admin app with Riverpod + Dio + GoRouter [P]
  Done when: `flutter run` launches admin app; GoRouter configured with route groups from spec (dashboard, orders, fulfillment, shipments, inventory, products, support, disputes, customers, settings); Riverpod providers for auth state; Dio configured with base URL + auth interceptor; admin login screen works against SuperTokens

- [x] T077 Implement admin dashboard screen
  Done when: dashboard shows operational counts (orders awaiting fulfillment, open tickets, low stock variants, open disputes, shipment exceptions); counts fetched from GET /admin/dashboard/summary; quick links to filtered views; widget tests verify layout and data display

- [x] T078 Implement admin order management screens
  Done when: order list with filters (status, payment, fulfillment, shipping, date range, search); order detail with tabs (summary, items, payment, fulfillment, shipping, support, evidence, audit); refund and cancel actions with confirmation dialogs; real-time updates via WebSocket; widget tests for list and detail

- [x] T079 Implement admin fulfillment + shipment screens
  Done when: fulfillment task queue with assignment; pick/pack workflow screens; shipment creation, label purchase, tracking view; real-time queue updates; widget tests

- [x] T080 Implement admin inventory + product screens
  Done when: inventory overview with low-stock highlighting; variant balance detail; adjustment creation; product CRUD with variant/media/classification management; widget tests

- [x] T081 Implement admin support + dispute screens
  Done when: ticket queue with filters; ticket detail with message thread + internal notes; dispute detail with evidence readiness, bundle generation; widget tests

- [x] T082 Implement admin settings + contributor management screens
  Done when: admin user management; role/permission configuration; contributor list with royalty status; widget tests

---

## Phase 12: Flutter Customer App Shell [Customer requirements]

- [x] T083 Initialize Flutter customer app with Riverpod + Dio + GoRouter [P]
  Done when: `flutter run` launches customer app; GoRouter configured with routes (catalog, product detail, cart, checkout, orders, support, warranty, account, contributor dashboard); auth flow: signup → email verification → login; GitHub OAuth link in account settings; Dio configured with auth interceptor

- [x] T084 Implement catalog + product detail screens
  Done when: product grid/list with images, pricing, availability; product detail with material variant selector (TPU/PA11/TPC); material-specific warranty info displayed; add to cart button; widget tests

- [x] T085 Implement kit builder screen
  Done when: kit selection UI: shows class requirements (e.g., "Pick 2 Plates"), available products per class, in-stock indicator; validates all classes satisfied; shows kit price + savings vs individual; add kit to cart; widget tests

- [x] T086 Implement cart + checkout screens
  Done when: cart with item list, quantity adjustment, remove; checkout: saved address selection or new address entry; shipping rate display (from EasyPost); tax display; Stripe payment (using Stripe SDK for Flutter); order confirmation; widget tests

- [x] T087 Implement order history + tracking screens
  Done when: order list with status badges; order detail with timeline (status changes); shipment tracking with carrier events; real-time updates via WebSocket; widget tests

- [x] T088 Implement support + warranty screens
  Done when: create ticket; message thread with attachments; file warranty claim (select order → describe defect → upload photos); warranty period validation shown to user; widget tests

- [x] T089 Implement contributor dashboard screen
  Done when: visible only when GitHub account linked; shows designs, per-design sales, royalty accrual, milestone progress (with visual progress bars), payout history; widget tests

---

## Phase 13: Astro Site Evolution [FR-088 through FR-092]

- [x] T090 Implement SSG product catalog pages [FR-088] [P]
  Done when: Astro generates static product listing page from API data at build time; product detail pages with variants, pricing, media, material warnings; SEO metadata (title, description, OpenGraph); existing STL viewer preserved for 3D model products

- [x] T091 Implement guest checkout as Astro islands [FR-089, FR-012a] [consumes: IC-009, IC-010]
  Done when: checkout UI as client-side Astro islands; cart stored via cart_token in localStorage; email + address form; Stripe Elements for payment; shipping rate selection; tax display; order confirmation page; US-only address validation; integration test: full guest checkout flow

- [x] T092 Implement kit builder page [FR-007, FR-088]
  Done when: Astro page with client-side kit builder island; class requirements displayed; product selection per class; availability checking; price + savings display; add to cart integration

- [x] T093 Add contributions model page [FR-090] [P]
  Done when: Astro page describing contributor incentives: milestones table, royalty structure, CLA process, donation option; linked from README

- [x] T094 Add warranty, returns, and care instructions pages [FR-091, FR-092] [P]
  Done when: warranty page with material-specific disclaimers (TPU heat >60°C, TPC 130°C rating); returns policy (30 days, conditions); safety disclaimer; care instructions per material tier; pages linked from footer and product detail pages

- [x] T095 Update README with contributions model
  Done when: README includes contributions model table (milestones + rewards), link to Astro contributions page, CLA instructions

---

## Phase 14: Integration Test Hardening [gates Phase 15 E2E]

Every integration test must exercise the whole app against live services (Postgres + SuperTokens + API brought up by `bash test/e2e/setup.sh`; source env from `test/e2e/.state/env.sh` before running `pnpm --dir api test`). No `describe.skip`, no `canRun` guards, no try/catch that swallows `beforeAll` errors, no vacuous assertions (`toBeDefined()` / `toBeTruthy()` / bare `typeof` as the only check). See [../../.claude/skills/spec-kit/reference/testing.md](../../.claude/skills/spec-kit/reference/testing.md) § "Test tier taxonomy" and § "Zero-skips rule" for the full pattern.

Tasks in this phase run **sequentially** — integration tests share one Postgres/SuperTokens instance; parallel execution pollutes fixtures. Ordering follows subdomain dependency (infra → auth → catalog → cart → orders → inventory → admin → fulfillment → payments → support → evidence → contributors → notifications) so downstream fix agents can assume upstream tiers are green.

Every per-file task (T200-range) has the same done-when shape: file runs green against live services, all skip guards removed, all vacuous assertions replaced with concrete behavior checks, every public handler the file covers has both happy-path AND error-path tests, no mocking of DB / auth / internal service calls, every FR mapped in the description is verified by at least one `it()` block that drives the real path end-to-end.

Every user-flow task (T260-range) creates a new multi-step integration test that mirrors an E2E flow at the API layer — same business flow the E2E drives via UI, but exercised via HTTP calls through the real API against real services. These are the cheap sibling to the E2E tier: when an E2E fails, the mirror flow test tells you whether the bug is in the API or past it.

### Infrastructure + DB (foundation — everything else depends on these)

- [x] T200 Harden `db/db.integration.test.ts` — Postgres connection, migrations, query helpers
  Done when: file runs green against live services (source `test/e2e/.state/env.sh` first); no skip guards; every DB helper touched by the file has a concrete-value assertion (not just `toBeDefined()`); connection failure path tested (bad URL → loud failure, not silent); no FR tags in the file — infer from `api/src/db/connection.ts` what behaviors need coverage.

- [x] T201 Harden `ready.integration.test.ts` — `/ready` readiness probe [FR-103]
  Done when: file runs green; no skip guards; `/ready` tested for all three states (not-ready at startup, ready when DB up, back to 503 when DB disconnected); every response body field (status, uptime, dependencies, version) has a concrete-value assertion; error paths (DB down, SuperTokens unreachable) produce the correct HTTP status with correct error shape.

- [x] T202 Harden `critical-path.integration.test.ts` — multi-phase end-to-end checkpoint [Phase 3, Phase 5, Phase 6]
  Done when: both Phase 3 and Phase 5/6 `describe` blocks run green; no skip guards anywhere (including the outer try/catch that swallowed setup errors); every assertion checks specific state (order status, inventory balance, snapshot contents), not existence; if the test needs test fixtures, it creates them in `beforeAll` and tears them down in `afterAll` — no shared state with other integration tests.

### Auth (everything downstream needs sessions working)

- [x] T203 Harden `auth/auth.integration.test.ts` — customer email/password + email verification [T032, FR-064]
  Done when: signup creates user + customer row (assert both); unverified user gets 401 on protected routes; verified user can access protected routes; login returns valid session tokens (assert token shape); bad credentials return 401 with correct error code; integration covers rate-limit rejection on repeated bad attempts.

- [x] T204 Harden `auth/admin-auth.integration.test.ts` — admin auth + role-based access
  Done when: admin login succeeds with correct role claim; non-admin users get 403 on admin routes (not 401); capability checks verified for each role tier (super_admin vs operator vs support); session expiry path tested.

- [x] T205 Harden `auth/email-conflict.integration.test.ts` — email collision handling [T054e]
  Done when: signup with an existing email returns 409 with `ERR_EMAIL_CONFLICT`; existing user's password/session unaffected; the conflict response doesn't leak whether the email exists at a different tier (enumeration defense); case-insensitive conflict detection verified.

- [x] T206 Harden `auth/github-link.integration.test.ts` — GitHub OAuth linking [T033, FR-068]
  Done when: OAuth callback creates customer + links `github_id`; re-linking same GitHub ID is idempotent; attempting to link a GitHub ID already on another account returns conflict; unlink flow verified; session is preserved across link/unlink.

- [x] T207 Harden `auth/guest-order-link.integration.test.ts` — guest-to-authenticated order linking [T036, FR-066]
  Done when: guest order created with email matches a new signup → order associates on signup; existing account signup pulls in prior guest orders with same email; linking respects email verification (doesn't link unverified); duplicate link attempts are idempotent.

- [x] T208 Harden `auth/audit-log.integration.test.ts` — auth event audit trail
  Done when: every auth event (login, logout, signup, password reset, failed-login) writes a row to the audit table with correct event_type, actor_id, timestamp, ip_address, user_agent; admin audit-log endpoint returns paginated entries filtered by actor / event_type / date range; non-admins can't read audit log.

### Catalog + kits (products must exist before orders)

- [x] T209 Harden `public-catalog.integration.test.ts` — public product catalog API [T044]
  Done when: `GET /api/products` returns only active products (draft/archived filtered); `GET /api/products/:slug` returns full product with variants + media + pricing + inStock flag; non-existent slug returns 404; out-of-stock variant flagged correctly; response shape matches exactly (every field asserted).

- [x] T210 Harden `catalog/variant-class.integration.test.ts` — product variant classification
  Done when: variant-class CRUD endpoints return correct shapes; invalid class assignments return 400; archived classes don't appear in public endpoints but do appear in admin endpoints; class-to-product mapping persists and round-trips.

- [x] T211 Harden `kit-composition.integration.test.ts` — kit definition + class requirements [T047]
  Done when: kit with multiple classes validates that a selection satisfies each class; missing-class selection returns 400 with which class is missing; wrong-variant-for-class returns 400; active-only product selection enforced; kit savings calculation is concrete (assert exact price math).

- [x] T212 Harden `kit-revalidation.integration.test.ts` — kit cart re-validation on state change [T054a]
  Done when: kit in cart with a variant that goes out-of-stock revalidates with 409 and specific out-of-stock detail; product archived after add triggers revalidation; price change triggers revalidation; revalidation is idempotent (repeated calls return same conclusion).

- [x] T213 Harden `customer-address.integration.test.ts` — customer address CRUD [T045]
  Done when: authenticated user can create/read/update/delete own addresses; trying to access another user's address returns 404 (not 403, to avoid existence leak); address validation rejects incomplete addresses with per-field errors; default-address behavior verified (only one default per user at a time).

### Cart + checkout (orders get created)

- [x] T214 Harden `cart.integration.test.ts` — cart lifecycle [T046, FR-007..012]
  Done when: guest cart created with cart_token; add/remove/update items with exact quantity + price assertions; kit-to-cart flow verified; out-of-stock item blocks add-to-cart with 409; cart handoff on signup (guest → authenticated) preserves items; expired cart cleanup tested.

- [x] T215 Harden `checkout.integration.test.ts` — checkout → payment intent + tax + shipping [FR-012..018]
  Done when: happy-path checkout produces client_secret + correct totals; invalid shipping address returns 400 with field errors; Stripe Tax calculation path verified (TX address → non-zero tax); shipping rate selection persists; checkout against stale cart (items changed) returns 409 with the conflict detail; repeated checkout on same cart returns consistent totals.

- [x] T216 Harden `policy-acknowledgment.integration.test.ts` — customer policy acknowledgment
  Done when: checkout requires policy acknowledgment (ToS, warranty disclaimer); submission without acknowledgment returns 400 naming the missing policy; acknowledgment persists with timestamp + policy version; re-acknowledgment required when policy version bumps.

### Orders + state machine (lifecycle transitions)

- [x] T217 Harden `order-state-machine.integration.test.ts` — order state transitions [T050]
  Done when: every legal transition from the state machine diagram produces correct side effects (events, notifications, inventory); every illegal transition returns 409 with ERR_INVALID_TRANSITION; terminal states (shipped, cancelled, refunded) reject all further transitions; state transition audit log entries written.

- [x] T218 Harden `order-cancel.integration.test.ts` — order cancellation
  Done when: customer-initiated cancel before ship succeeds + releases reservation + refunds via Stripe; cancel after ship returns 409; admin force-cancel path with audit log entry; partial cancel (single line item) produces correct recalculated totals.

- [x] T219 Harden `resend-confirmation.integration.test.ts` — resend order confirmation email [T059d]
  Done when: resend triggers email with same order contents; rate-limited (can't spam-resend); only owner can resend their order; non-existent order returns 404; emails go to `logs/emails.jsonl` with full content asserted.

- [x] T220 Harden `duplicate-ticket.integration.test.ts` — duplicate support ticket detection [T061, T061a]
  Done when: creating a duplicate ticket (same order + same category within N days) returns 409 with the existing ticket ID; not a duplicate if different category; not a duplicate if outside the window; admin override to force-create verified.

### Inventory + reservations (stock constraints)

- [x] T221 Harden `low-stock-alert.integration.test.ts` — low-stock threshold + admin notification [FR-038, FR-085]
  Done when: variant dropping below safety_stock fires an alert via admin WebSocket + email within expected latency; threshold changes update alert behavior; alert includes variant SKU + product title + available count + threshold; alerts deduplicated within cooldown window.

- [x] T222 Harden `reservation-cleanup.integration.test.ts` — expired reservation cleanup job
  Done when: reservations past TTL get released by the cleanup job; released inventory is available for new reservations; cleanup is idempotent; cleanup job writes metrics (count released, count kept).

- [x] T223 Harden `reservation-expiry-race.integration.test.ts` — expiry ↔ late payment race [FR-E008]
  Done when: reservation expires then payment_intent.succeeded arrives: either re-reserves successfully OR flags the order for manual review with admin alert (both branches exercised); stock-available and stock-exhausted setups both tested; order final state is deterministic.

### Admin (admin tooling over the product + order domain)

- [ ] T224 Harden `admin-customers.integration.test.ts` — admin customer lookup + actions
  Done when: admin can search customers by email/name/order ID; customer detail view shows orders + addresses + audit trail; ban/unban customer endpoint verified; PII access gated by role (super_admin only for full PII, operator sees redacted).

- [ ] T225 Harden `admin-dashboard.integration.test.ts` — admin dashboard aggregates
  Done when: dashboard endpoint returns correct aggregates (open orders, pending fulfillments, stuck reservations, low-stock count) against seeded fixture data; date range filter verified; timezone handling asserted.

- [ ] T226 Harden `admin-inventory.integration.test.ts` — admin inventory adjustments
  Done when: positive adjustment (restock) increases balance with audit; negative adjustment (shrinkage) decreases with reason required; attempting to drive balance negative returns 400; adjustment history queryable per variant; bulk adjustment endpoint verified.

- [ ] T227 Harden `admin-products.integration.test.ts` — admin product CRUD
  Done when: create product with variants + media + pricing succeeds; updating price updates the active snapshot; archive propagates to variants (cannot add to cart); slug collision returns 400; media upload URL signing verified.

- [ ] T228 Harden `admin-reservation.integration.test.ts` — admin reservation view + override
  Done when: admin can list active reservations filtered by variant/customer/expiry; force-release reservation endpoint succeeds with audit entry; stats endpoint returns correct counts; non-admin access returns 403.

- [ ] T229 Harden `admin-settings.integration.test.ts` — admin-writable settings
  Done when: settings GET returns current values; PATCH persists changes and fires a `settings.changed` event; invalid setting keys rejected with 400; role-gated settings (e.g. payment processor keys) editable only by super_admin.

### Fulfillment + shipping (post-order physical flow)

- [ ] T230 Harden `fulfillment-task.integration.test.ts` — fulfillment task lifecycle [T056]
  Done when: task auto-created on order confirmation; task assignment persists; state transitions (pending → picking → packed → shipped) fire correct events; abandoned task (stale) flagged for admin review.

- [ ] T231 Harden `shipment.integration.test.ts` — shipment creation + tracking [T058]
  Done when: buy-label produces shipment row with carrier + tracking number + rate; tracking updates via EasyPost webhook move shipment state; void-label path creates correct void record; shipment linked back to order + fulfillment task.

- [ ] T232 Harden `fulfillment-propagation.integration.test.ts` — fulfillment events propagate to order [T060]
  Done when: shipment.created updates order.status = shipped; shipment tracking event (delivered) updates order.status = delivered; out-of-order events handled idempotently; customer + admin WebSocket notifications fire with exact payloads asserted.

- [ ] T233 Harden `fulfillment-edge-cases.integration.test.ts` — fulfillment edge cases [T066c]
  Done when: returned shipment, partial ship, split ship, multi-parcel ship all handled; label voided after ship flagged for investigation; carrier API timeout falls back to retry queue; each edge case has a concrete assertion on the final DB + event state.

- [ ] T234 Harden `shipping-edge-cases.integration.test.ts` — shipping address/rate edge cases [T066d]
  Done when: invalid shipping address returns 400 with specific field errors; no-rate-available path handled; PO Box rejection for ship-only carriers; international address rejected with clear reason (US-only); address normalization (street abbreviations, state codes) verified.

- [ ] T235 Harden `void-label.integration.test.ts` — label voiding [T059a]
  Done when: void within carrier window succeeds; void after carrier window rejects with 409; void of already-scanned label rejects; void creates correct refund accounting on the shipment cost; audit entry for each void.

### Payments + webhooks (external integrations)

- [ ] T236 Harden `webhook.integration.test.ts` — Stripe webhook event handling [FR-030, FR-080]
  Done when: every webhook event type the API subscribes to (payment_intent.succeeded, payment_intent.payment_failed, charge.dispute.created, etc.) is processed with specific-state assertion; signature verification rejects bogus webhooks with 400; idempotency keys prevent duplicate processing; event ordering handled (succeeded-then-dispute vs dispute-then-succeeded).

- [ ] T237 Harden `easypost-webhook.integration.test.ts` — EasyPost tracking webhooks [T059]
  Done when: tracker_updated events update shipment state with correct timestamp; signature verification rejects unsigned/bogus payloads; out-of-order events (delivered before in_transit) handled without regression; unknown tracking ID logs + discards without erroring.

- [ ] T238 Harden `refund.integration.test.ts` — admin refund (full + partial) through Stripe [FR-030]
  Done when: full refund against a paid order succeeds + updates order status + fires event; partial refund with specific amount verified; refund on already-refunded order returns 409; refund failure from Stripe logged + order kept in pending-refund state; admin audit entry for each refund with actor + reason.

- [ ] T239 Harden `stripe-unreachable.integration.test.ts` — Stripe API outage handling
  Done when: checkout with Stripe unreachable returns 503 with retry-after header (not 500); partially-processed orders roll back cleanly; circuit-breaker triggers after N consecutive failures; health endpoint reflects degraded payment state.

### Support + warranty (tickets)

- [ ] T240 Harden `support-ticket.integration.test.ts` — support ticket CRUD [T061, FR-050]
  Done when: customer creates ticket linked to order; admin replies thread into ticket; ticket state transitions (open → pending → resolved) audit correctly; SLA overdue flag set after N hours without admin response; ticket search by order/customer/status verified.

- [ ] T241 Harden `ticket-attachment.integration.test.ts` — ticket attachments [T062]
  Done when: upload attachment returns signed URL; attachment size limit enforced (413 response); content-type whitelist enforced; cross-tenant access blocked (customer can only see their own ticket's attachments); deletion revokes access.

- [ ] T242 Harden `warranty-claim.integration.test.ts` — warranty claim submission [T063, FR-055]
  Done when: submit claim with order + issue description + photos; warranty period check (rejects claims past window); valid claim creates ticket with `category=warranty`; material-specific checks (TPU heat disclaimer) verified; non-owner can't submit claim for someone else's order.

### Evidence + disputes (dispute lifecycle)

- [ ] T243 Harden `evidence-auto-collection.integration.test.ts` — auto-collection of dispute evidence [T065]
  Done when: charge.dispute.created triggers evidence collection job; collected evidence includes order + shipping + customer + policy acknowledgments; evidence bundle size within Stripe limit; collection is idempotent (same dispute twice = same bundle).

- [ ] T244 Harden `evidence-browsing.integration.test.ts` — admin evidence browser [T066b]
  Done when: admin can list open disputes with evidence status; drill-down shows each piece of evidence with source; filter by status (pending, submitted, won, lost) returns correct counts.

- [ ] T245 Harden `evidence-bundle.integration.test.ts` — submitting evidence bundle to Stripe [T066]
  Done when: bundle submission to Stripe test mode succeeds; Stripe rejection (bad format) captured with specific error; resubmit after correction path verified; bundle submission locks further evidence edits.

- [ ] T246 Harden `manual-evidence.integration.test.ts` — admin-added manual evidence [T066a]
  Done when: admin can attach additional documents to evidence bundle; admin-added evidence tagged with actor; rejected content types blocked; removal path verified with audit.

### Contributors + royalties (derived numbers)

- [ ] T247 Harden `contributor.integration.test.ts` — contributor onboarding + profile [T067]
  Done when: contributor signup via GitHub; profile with STL upload flow; CLA acceptance persists with version + timestamp; profile visibility setting (public/private) respected in public endpoints.

- [ ] T248 Harden `contributor-dashboard.integration.test.ts` — contributor dashboard data [T071]
  Done when: dashboard shows units-sold, earned royalties, milestone progress with exact number assertions; date range filter works; timezone handling verified; non-owner can't see another contributor's dashboard.

- [ ] T249 Harden `contributor-milestones.integration.test.ts` — milestone transitions [T070, FR-071..075]
  Done when: 25-unit threshold triggers retroactive 10% royalty on first 25 units; 50-unit starter kit milestone awarded; 500-unit milestone switches to 20% rate; milestone events fire WebSocket notifications; milestone state visible in contributor profile.

- [ ] T250 Harden `contributor-sales.integration.test.ts` — sales attribution [T068]
  Done when: order with a contributor-authored product credits the contributor with correct share; multi-product orders split attribution correctly; refunds reverse attribution; kits with mixed-contributor products split per product line.

- [ ] T251 Harden `royalty-engine.integration.test.ts` — royalty calculation engine [T069]
  Done when: engine computes royalty per order-line with correct rate tier; edge cases (zero-price promo, refunded line) produce correct zero/negative; monthly rollup aggregates match per-order sum; donation-option path (501(c)(3)) routes amount correctly.

### Notifications + realtime (delivery layer)

- [ ] T252 Harden `notification-dispatch.integration.test.ts` — notification delivery via email + WebSocket
  Done when: every notification type in the spec has both delivery channels tested; customer email preference respects opt-out; admin notifications broadcast to connected admins; delivery retries on transient failure; permanent failure logged to dead-letter queue.

- [ ] T253 Harden `websocket.integration.test.ts` — WebSocket session + event broadcast [FR-081, FR-082]
  Done when: customer connects with session cookie → receives own order events; admin connects → receives admin-channel events; cross-customer isolation verified (customer A doesn't see customer B's events); unauthenticated connection rejected; reconnect-with-last-event-id replays missed events.

- [ ] T254 Harden `domain-events.integration.test.ts` — domain event publishing + subscribers
  Done when: each domain event has a concrete producer + at least one subscriber asserted; event ordering preserved per-aggregate; failed subscribers don't block other subscribers; event table persists with full payload for audit replay.

### Cross-domain user-flow integration tests (mirror of E2E flows)

Each task below creates a NEW file under `api/src/flows/` that walks the same multi-step flow an E2E task drives, but via HTTP calls against the real stack — no emulator / browser. Purpose: fast (seconds, not minutes) coverage of the complete user journey. When an E2E fails, the mirror flow test tells you whether the bug is in the API layer or past it.

- [ ] T260 Flow test: guest checkout on Astro [mirrors T096, SC-001]
  Done when: new `api/src/flows/guest-checkout.integration.test.ts` walks: fetch catalog → add to cart → set shipping address → compute totals → create payment intent → simulate Stripe confirm via webhook → verify order.status=paid → verify snapshots (price, tax, shipping) are frozen on the order. Runs green against live services with zero skips.

- [ ] T261 Flow test: authenticated checkout [mirrors T097, SC-001]
  Done when: new `api/src/flows/authenticated-checkout.integration.test.ts` walks: signup → verify email → login → add to cart → use saved address → checkout → Stripe webhook → order confirmed → order appears in customer order history with correct status transitions.

- [ ] T262 Flow test: kit purchase [mirrors T098, SC-010]
  Done when: new `api/src/flows/kit-purchase.integration.test.ts` walks: fetch kits → select a kit → choose variant per class → add-to-cart → checkout → verify kit row-items in order with correct per-variant pricing and kit savings; also tests the invalid-selection branch (missing class → 400).

- [ ] T263 Flow test: full fulfillment + shipping [mirrors T099, SC-005, SC-006]
  Done when: new `api/src/flows/fulfillment-shipping.integration.test.ts` walks: paid order → fulfillment task created → admin assigns → admin buys label → shipment created → EasyPost webhook simulating in_transit + delivered → order.status transitions correctly → customer receives WebSocket notifications for each step (asserted via live WS connection).

- [ ] T264 Flow test: dispute lifecycle [mirrors T100, SC-005]
  Done when: new `api/src/flows/dispute-lifecycle.integration.test.ts` walks: paid+shipped order → simulate `charge.dispute.created` webhook → auto-evidence collection fires → admin reviews + submits evidence bundle → simulate dispute won/lost webhooks → verify final order state + refund accounting.

- [ ] T265 Flow test: contributor royalty [mirrors T101, SC-011]
  Done when: new `api/src/flows/contributor-royalty.integration.test.ts` walks: contributor signup → product created and attributed → N units sold crossing each milestone → royalty ledger entries verified at each threshold (retroactive 10%, 20% rate change, starter kit); also verifies contributor dashboard totals match ledger sum.

- [ ] T266 Flow test: concurrent inventory [mirrors T102, SC-003]
  Done when: new `api/src/flows/concurrent-inventory.integration.test.ts` walks: N concurrent checkouts against a variant with stock M<N → exactly M succeed, N-M fail with 409 and specific out-of-stock; final balance = 0; no over-sell, no negative balance; all reservations accounted for.

- [ ] T267 Flow test: WebSocket real-time propagation [mirrors T103, SC-007]
  Done when: new `api/src/flows/websocket-realtime.integration.test.ts` walks: customer + admin both connected via WS → admin creates shipment → customer receives `shipment.created` + tracking events within latency budget (asserted); customer posts support ticket message → admin receives `ticket.updated`; admin internal note NOT delivered to customer (asserted absence).

- [ ] T268 Flow test: security boundary enforcement [mirrors T104, SC-008, SC-015]
  Done when: new `api/src/flows/security-boundaries.integration.test.ts` exercises each trust boundary: unauthenticated → 401 on protected routes; customer token on admin route → 403; cross-customer access (customer A reads customer B) → 404 (existence hidden); session token replay after logout → 401; rate-limit exceeded → 429 with Retry-After.

- [ ] T269 Flow test: guest-order → account linking [mirrors T104a, FR-066]
  Done when: new `api/src/flows/guest-order-link.integration.test.ts` walks: guest checkout with email X → signup with email X → verify guest order linked to new account → guest order appears in authenticated order history → link is idempotent on repeat signup attempts.

- [ ] T270 Flow test: warranty claim submission [mirrors T104b, FR-055]
  Done when: new `api/src/flows/warranty-claim.integration.test.ts` walks: customer submits warranty claim for their order → verify ticket created with category=warranty → admin reviews → resolution path (approve/deny) → notifications delivered; also tests out-of-window claim rejection.

- [ ] T271 Flow test: admin refund (full + partial) through Stripe [mirrors T104c, FR-030]
  Done when: new `api/src/flows/admin-refund.integration.test.ts` walks: paid order → admin initiates full refund → Stripe test-mode refund succeeds → verify refund row + order state + customer notification; second walkthrough for partial refund verifying balance math; third walkthrough for double-refund attempt returning 409.

- [ ] T272 Flow test: reservation expiry → late payment race [mirrors T104d, FR-E008]
  Done when: new `api/src/flows/reservation-late-payment.integration.test.ts` walks: checkout creates short-TTL reservation → force expiry via cleanup job → fire `payment_intent.succeeded` webhook → both outcome branches exercised (re-reservation succeeded + order confirmed, OR order flagged for manual review with admin alert); stock-available and stock-exhausted setups.

- [ ] T273 Flow test: low-stock alert → notification delivery [mirrors T104e, FR-038, FR-085]
  Done when: new `api/src/flows/low-stock-alert.integration.test.ts` walks: variant with safety_stock=10 → inventory adjustment drops available to 9 → admin WebSocket receives alert within 2s → email logged to `logs/emails.jsonl` with variant SKU + product title + available count + threshold (all asserted).

- [ ] T274 Flow test: Stripe Tax calculation [mirrors T104f, FR-117, FR-118]
  Done when: new `api/src/flows/stripe-tax.integration.test.ts` walks: checkout with TX shipping → Stripe Tax API called → non-zero tax line on the order + PaymentIntent metadata includes tax breakdown; tax-exempt state → zero tax; missing-state returns 400. Preconditions: `STRIPE_TAX_ENABLED=true`, real `sk_test_...` key — if missing, setup fails loudly (no skip). This task may be deferred if test keys aren't provisioned.

- [ ] T275 Flow test: out-of-stock cart + kit rejection [mirrors T104h, FR-010]
  Done when: new `api/src/flows/out-of-stock-flow.integration.test.ts` walks: drive variant `available→0` via `POST /api/admin/inventory/adjustments` → assert public catalog returns `inStock: false` → `POST /api/cart/:id/items` returns 409 with `ERR_OUT_OF_STOCK` → kit containing the variant rejected at checkout → after `+N` restock, variant orderable again.

- [ ] T276 Phase 14 validation
  Done when: `bash test/e2e/setup.sh` exits 0; `source test/e2e/.state/env.sh && pnpm --dir api test` exits 0 with the reporter showing 0 failures AND 0 skips across all integration tests; every FR referenced in tasks T200–T275 has at least one `it()` block that drives the real end-to-end path; runner-verified.json for phase 14 shows passed=true.

---

## Phase 15: Integration + E2E [SC-001 through SC-018]

**MCP-driven E2E**: uses `nix-mcp-debugkit` servers (`mcp-browser` for Astro site, `mcp-android` for Flutter apps on Android emulator). iOS coverage via `mcp-ios` is deferred — Android exercises the same Flutter code paths for now. Tasks annotated `[needs: mcp-*, e2e-loop]` use the explore-fix-verify cycle: MCP agent takes screenshots, taps elements, reads accessibility trees, finds bugs, fixes code, writes a regression test, re-runs. **Every bug fix gets a scripted regression test (Playwright for web, Patrol for Flutter) before the task is marked done — a fix without a test is not done.**

- [x] T095a Add `nix-mcp-debugkit` flake input + re-export packages + config writers
  Done when: root `flake.nix` adds `nix-mcp-debugkit.url = "github:mmmaxwwwell/nix-mcp-debugkit"` input; re-exports `packages.mcp-android = nix-mcp-debugkit.packages.${system}.mcp-android` and `packages.mcp-browser = nix-mcp-debugkit.packages.${system}.mcp-browser`; adds `packages.mcp-android-config` and `packages.mcp-browser-config` writers that emit `mcp/android.json` and `mcp/browser.json` pinning MCP commands to Nix store paths (mirror of nix-key `flake.nix`); `nix build .#mcp-android-config` produces a pinned config file; `nix run .#mcp-android -- --help` works; (iOS / `mcp-ios` deferred)

- [x] T095b Register MCP servers + required permissions in `.claude/settings.json`
  Done when: `.claude/settings.json` adds `permissions.allow` entries for: `Bash(nix run .#mcp-android:*)`, `Bash(nix run .#mcp-browser:*)`, `Bash(adb devices:*)`, `Bash(adb -s emulator-*:*)`, `Bash(adb shell:*)`, `Bash(adb logcat:*)`, `Bash(kvm-ok)`, and emulator screencap/pull commands; MCP server registrations point at the pinned config from T095a; smoke test: agent can call MCP tools without additional prompts

- [x] T095c KVM + emulator prereq verification + backend setup/teardown scripts
  Done when: `scripts/e2e-check-prereqs.sh` verifies `kvm-ok` passes and `egrep -c '(vmx|svm)' /proc/cpuinfo` > 0 (fail fast with clear message otherwise); `test/e2e/setup.sh` starts backend services in idempotent order: postgres → supertokens → api → astro site; kills orphan processes on known ports (3000, 3567, 4321, 5432); cleans stale sockets; writes `$STATE_DIR/env` with service URLs, test admin credentials, Stripe test key presence flag; `test/e2e/teardown.sh` reverses cleanly; the Android emulator itself is managed by the spec-kit runner's PlatformManager (not this script); mirror of nix-key `test/e2e/setup.sh`

- [x] T095d APK install + app launch scripts consumed by MCP runner
  Done when: `scripts/e2e-install-apks.sh` builds admin + customer Flutter debug APKs and installs both on the running emulator via `adb install -r`; `scripts/e2e-launch-admin.sh` and `scripts/e2e-launch-customer.sh` cold-start each app with `adb shell am start`; scripts idempotent; app package IDs documented (e.g., `com.kanix.admin`, `com.kanix.customer`)

- [x] T095e Set up Playwright + Patrol regression harnesses
  Done when: `site/tests/e2e/` has Playwright config running against local Astro served by `test/e2e/setup.sh`; `admin/integration_test/` and `customer/integration_test/` have Patrol config wired to `flutter test integration_test/`; both emit structured JSON to `test-logs/e2e/` for agent + CI consumption; `.github/workflows/e2e.yml` runs Playwright headless + Patrol on Android CI emulator on push

- [x] T096 E2E: guest checkout on Astro [SC-001] [needs: mcp-browser, e2e-loop, stripe-listen]
  Prereq: `pnpm --dir api stripe:listen:start` before running (see [test/e2e/README.md](../../test/e2e/README.md)); tear down with `stripe:listen:stop` after.
  Done when: MCP agent drives live Astro site: navigate to product → select variant → add to cart → checkout with email + address → pay via Stripe test → order confirmation; completes in <3 minutes; order exists in DB with correct snapshots; Playwright regression test exists for the full flow; every bug found during exploration has its own Playwright regression test

- [ ] T097 E2E: authenticated checkout on Flutter customer app [SC-001] [needs: mcp-android, e2e-loop, stripe-listen]
  Prereq: `pnpm --dir api stripe:listen:start` before running (see [test/e2e/README.md](../../test/e2e/README.md)); tear down with `stripe:listen:stop` after.
  Done when: MCP agent drives customer app on Android emulator: login → browse catalog → add to cart → checkout with saved address → Stripe test pay → order appears in history with real-time status update; Patrol regression test exists; each fixed bug has its own Patrol test; (iOS coverage deferred)

- [ ] T098 E2E: kit purchase [SC-010] [needs: mcp-browser, mcp-android, e2e-loop]
  Done when: MCP agent configures starter kit (2 plates + 3 modules + 1 belt) via kit builder on both Astro site and Flutter customer app → checkout → verify each component reserved individually in DB → payment → order with 6 line items; Playwright + Patrol regression tests exist for kit builder validation (incomplete kit rejected, out-of-stock swap)

- [ ] T099 E2E: full fulfillment + shipping [SC-005, SC-006] [needs: mcp-android, e2e-loop]
  Done when: MCP agent drives Flutter admin app: receive paid order → open fulfillment queue → pick → pack → create shipment → buy label (EasyPost test) → mark shipped → simulate tracking events → delivered; verify evidence records exist for every step in DB; verify audit log complete; Patrol regression test for full admin fulfillment flow

- [ ] T100 E2E: dispute lifecycle [SC-005] [needs: mcp-android, e2e-loop]
  Done when: delivered order → simulate `charge.dispute.created` webhook → MCP agent opens admin Dispute detail screen → verify evidence readiness shows all 5 types present → generate bundle → submit → close; Patrol regression test for admin dispute screen + bundle generation

- [ ] T101 E2E: contributor royalty [SC-011] [needs: mcp-browser, mcp-android, e2e-loop]
  Done when: create contributor → link design → MCP agent completes 25 orders on Astro site → verify retroactive royalty for units 1-25 in DB → MCP agent opens customer app contributor dashboard → verify dashboard shows correct totals + milestones → refund 1 order → verify clawback displayed → toggle donation option → verify 20% rate; Playwright + Patrol regression tests

- [ ] T102 E2E: concurrent inventory [SC-003]
  Done when: scripted test (no MCP needed — API-level concurrency): 1 unit available → 10 concurrent checkout POSTs → exactly 1 succeeds → 9 fail with ERR_INVENTORY_INSUFFICIENT → available = 0; runs in CI

- [ ] T103 E2E: WebSocket real-time [SC-007] [needs: mcp-android, e2e-loop]
  Done when: MCP agent opens admin app (observes order list) and customer app (observes order detail) simultaneously; scripted actor creates order via API → admin app shows order.placed within 2 seconds (MCP verifies UI update); shipment status change → customer app shows update within 2 seconds; Patrol regression test asserts UI reacts to WebSocket events

- [ ] T104 Security boundary tests [SC-008, SC-015]
  Done when: scripted API-level test: unauthenticated → 401 on all protected endpoints; wrong permission → 403; SQL injection attempts → rejected; XSS in input → sanitized in response; invalid webhook signature → rejected; runs in CI

- [ ] T104a E2E: guest-order → account linking [FR-066] [needs: mcp-browser, e2e-loop]
  Done when: MCP agent completes 3 guest checkouts on Astro with email `jane@example.com` → signup with same email → MCP verifies verification email link (reads from `logs/emails.jsonl` stub) → verify → login → all 3 orders appear in customer order history with customer_id populated in DB; Playwright regression test

- [ ] T104b E2E: warranty claim submission [FR-055] [needs: mcp-android, e2e-loop]
  Done when: MCP agent on Flutter customer app: login → order history → select delivered order within warranty window → file warranty claim (describe defect, upload 2 photos via MCP file-picker interaction) → verify support_ticket created with category=warranty_claim, priority=high, attachments accessible; MCP switches to admin app and verifies ticket in queue via WebSocket update; expired-warranty claim rejected with clear error (separate case); Patrol regression test

- [ ] T104c E2E: admin refund (full + partial) through Stripe [FR-030] [needs: mcp-android, e2e-loop, stripe-listen]
  Prereq: `pnpm --dir api stripe:listen:start` before running (see [test/e2e/README.md](../../test/e2e/README.md)); tear down with `stripe:listen:stop` after.
  Done when: MCP agent on admin app: open paid order → issue full refund → Stripe test refund processed → payment_status=refunded; MCP switches to customer app and verifies refund in order timeline via WebSocket; second test: partial refund → payment_status=partially_refunded; over-refund attempt rejected with ERR_REFUND_EXCEEDS_PAYMENT; audit log entries exist for both; Patrol regression tests for admin refund UI

- [ ] T104d E2E: reservation expiry → late payment race [FR-E008]
  Done when: scripted test (no MCP): create checkout → reservation created (short TTL) → force expiry via cleanup cron → fire payment_intent.succeeded webhook → verify either (a) re-reservation succeeded + order confirmed, or (b) order flagged for manual review with admin alert delivered via WebSocket; both branches exercised with stock-available and stock-exhausted setups

- [ ] T104e E2E: low-stock alert → notification delivery [FR-038, FR-085] [needs: mcp-android, e2e-loop]
  Done when: set variant safety_stock=10 → MCP agent opens admin app with email preference → scripted actor adjusts inventory so available drops below threshold → MCP verifies in-app notification appears in admin UI within 2s AND email logged to `logs/emails.jsonl` with correct variant SKU, product title, available count, threshold; Patrol regression test

- [ ] T104f E2E: Stripe Tax calculation with live test key [FR-117, FR-118] [needs: mcp-browser, e2e-loop, stripe-listen]
  Prereq: `pnpm --dir api stripe:listen:start` before running (see [test/e2e/README.md](../../test/e2e/README.md)); tear down with `stripe:listen:stop` after.
  Done when: MCP agent drives Astro checkout with TX shipping address → verify Stripe Tax API called → non-zero tax displayed in UI → tax reflected in PaymentIntent metadata and order totals; separate MCP run with tax-exempt state → correct tax displayed; Playwright regression test. Preconditions (MUST all be live before the test starts; setup fails loudly if any is missing — no skip fallback): `STRIPE_TAX_ENABLED=true`, real Stripe test key in `STRIPE_SECRET_KEY`, Stripe webhook listener running. If credentials are not present in the runner environment, provision them or exclude this task from the run — never silently skip.

- [ ] T104g E2E: cross-app real-time propagation [FR-081, FR-082] [needs: mcp-android, e2e-loop]
  Done when: MCP agent opens customer app (customer session) and admin app (admin session) simultaneously → MCP on admin creates shipment + buys label for customer's order → MCP verifies customer app receives shipment.created + tracking events in UI within 2s; MCP on customer posts support ticket message → MCP verifies admin app receives ticket.updated in UI within 2s; admin internal note NOT delivered to customer UI (MCP verifies absence); Patrol regression tests on both sides

- [ ] T104h E2E: out-of-stock cart + kit rejection [FR-010, spec.md AS-2, AS-51] [needs: mcp-browser, e2e-loop]
  Drive state through the admin inventory API — NEVER edit `api/src/db/scripts/seed.ts`. See [test/e2e/README.md § Controlling test state](../../test/e2e/README.md#controlling-test-state-stock-reservations-etc).
  Done when: test picks a dedicated variant (or creates one), drives `available → 0` via `POST /api/admin/inventory/adjustments` with a negative `quantity_delta`, then asserts:
    (a) public catalog endpoint flags the variant `inStock: false`;
    (b) Astro site PDP shows "Out of Stock" and the add-to-cart button is disabled;
    (c) `POST /api/cart/:id/items` for that variant returns 409 with `ERR_OUT_OF_STOCK` (or equivalent);
    (d) a kit containing that variant in one of its classes cannot check out — customer must swap to an available alternative (FR-010);
    (e) after a `+N` restock adjustment, the same variant becomes orderable again.
  Test creates its own fixture variant where possible; if it must reuse seeded data, it MUST restock to the original count in teardown. Test writes structured output to `test-logs/e2e/` and appears in `summary.json` with `pass > 0`. Skips are never acceptable — `skip > 0` fails the build unconditionally (see [api/src/test-reporter.ts](../../api/src/test-reporter.ts) and spec-kit `reference/testing.md` § "Zero-skips rule").

- [ ] T105 Create/verify UI_FLOW.md for admin and customer apps
  Done when: UI_FLOW.md documents all screens, routes, state machines, API calls, field validations, and real-time connections for both Flutter apps and Astro checkout; every flow has a corresponding E2E test reference and an MCP exploration task above

---

## Phase 16: Infrastructure + Deploy [FR-093 through FR-097]

- [ ] T106 Write OpenTofu configurations [FR-093, FR-094]
  Done when: `deploy/tofu/` provisions: server(s), Cloudflare DNS records, networking; `tofu plan` from fresh state shows create-only; `tofu apply` provisions infrastructure; variables for all configurable values

- [ ] T107 Write NixOS server modules [FR-095, FR-096]
  Done when: `deploy/nixos/` modules: api-server (Fastify as systemd service), postgres (with auth, logging, daily backup), nginx (reverse proxy, Let's Encrypt, WebSocket upgrade, security headers), supertokens (as service), common (firewall, SSH hardening); modules compose into a complete server config

- [ ] T108 Write Nix VM tests [FR-097]
  Done when: `deploy/tests/test-*.nix` validate per TEST-METHODOLOGY.md: service binding (correct ports/interfaces), firewall rules (allowed + denied), TLS config (no weak ciphers), Postgres access control, Nginx proxy behavior; `nix build .#checks.x86_64-linux.<test>` passes for all tests

- [ ] T109 Configure CI/CD deploy pipeline [needs: gh]
  Done when: `.github/workflows/deploy.yml` runs on main push after tests pass; builds API, builds site, deploys to server; rollback on failure; environment secrets configured

---

## Phase 17: Operations Runbook + Final Validation [FR-102]

- [ ] T110 Write RUNBOOK.md [FR-102]
  Done when: RUNBOOK.md documents: day-1 developer setup, day-2 ops with cadence (DB backups daily, vacuum weekly, dep updates weekly, cert monitoring, inventory cleanup, Stripe health, log rotation), failure recovery per component (Postgres down, Stripe webhook failures, SuperTokens unreachable, EasyPost errors), escalation procedures, Liquibase rollback procedures, OpenTofu plan/apply workflow.
  Required Stripe section must cover: (1) dev webhook forwarding lifecycle — `pnpm --dir api stripe:listen:start` / `stop` scripts, why the secret rotates per session, API restart requirement; (2) test vs. live mode — how to identify current mode from `STRIPE_SECRET_KEY` prefix, guardrails preventing live keys in dev, separate `whsec_` per environment; (3) production webhook endpoint setup — registering the endpoint in Stripe dashboard, selecting event types (payment_intent.succeeded, charge.refunded, charge.dispute.created, etc.), copying the persistent `whsec_` into prod env; (4) webhook delivery failure recovery — how to detect failed deliveries via Stripe dashboard's Event log, replaying events, idempotency guarantees of our handler; (5) secret rotation — rotating `sk_live_` without downtime (dual-key window in Stripe dashboard), updating `STRIPE_WEBHOOK_SECRET` after rotation, verifying with a test payment; (6) fraud / dispute response — identifying unusual charges, initiating refunds via admin app vs. Stripe dashboard, dispute evidence submission; (7) monitoring — key Stripe dashboard panels to watch (failed webhooks, high dispute rate, payment success rate), alerting hookup points in our observability stack; (8) common errors — ERR_EXTERNAL_SERVICE_UNAVAILABLE causes, PaymentIntent state machine gotchas, tax calculation failures with STRIPE_TAX_ENABLED.

- [ ] T111 Final security scan + vulnerability review [SC-008]
  Done when: full security scan (Trivy + Semgrep + Gitleaks + npm audit) passes with zero critical findings; SARIF uploaded to GitHub Security tab; any findings documented with justification or fix

- [ ] T112 Final E2E validation of all user flows
  Done when: all SC-001 through SC-018 validated; all E2E tests from Phase 14 pass; UI_FLOW.md verified against implementation; no BLOCKED.md files remaining

- [ ] T113 Documentation review
  Done when: README complete with contributions model; CLAUDE.md up to date with all scripts and structure; RUNBOOK.md reviewed; API documentation generated; warranty/returns pages accurate
