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

- [ ] T026 Create initial migration: all core entities from data-model.md [FR-032, FR-033]
  Done when: changeset creates all tables from data-model.md; CHECK constraints: `available >= 0`, `reserved >= 0`, `on_hand >= 0`, `price_minor > 0`; unique constraints: `(variant_id, location_id)` on inventory_balance, `order_number` on order, `sku` on product_variant, `slug` on product; FK constraints with RESTRICT; migration runs clean against empty DB; rollback drops all tables

- [ ] T027 Set up Drizzle ORM with schema introspection [FR-032] [consumes: IC-001]
  Done when: Drizzle schema files in `api/src/db/schema/` reflect all tables from migration; typed queries in `api/src/db/queries/`; `SELECT 1` query succeeds via Drizzle; integration test: insert and read a product row with type safety

- [ ] T028 Create seed script with dev data [FR-101]
  Done when: `pnpm db:seed` populates: 5 products with TPU/PA11/TPC variants, product classes (plates/modules/belts), kit definition (starter kit), inventory balances (50 units each), 1 admin user (super_admin role), 1 inventory location (default warehouse); seed is idempotent (safe to run multiple times); `pnpm db:reset` drops + recreates + migrates + seeds

- [ ] T029 Update /ready to check Postgres connectivity [FR-103]
  Done when: `GET /ready` returns 200 when Postgres is connected; returns 503 with `{dependencies: {database: "down"}}` when Postgres is unreachable; integration test verifies both states

- [ ] T030 Critical path checkpoint (Phase 3) [Critical Path]
  Done when: integration test verifies: server boots → /health 200 → /ready 200 (DB connected) → seed data queryable via Drizzle → server shuts down cleanly

---

## Phase 4: Auth + Admin Identity [FR-064, FR-065, FR-066, FR-068, FR-077, FR-078, FR-079, FR-080]

- [ ] T031 Configure SuperTokens in process-compose and deploy/nixos [FR-064]
  Done when: `process-compose up` starts SuperTokens core on port 3567; health check confirms SuperTokens is up; `deploy/nixos/supertokens.nix` configures SuperTokens core with Postgres backend

- [ ] T032 Implement customer auth: email/password + email verification [FR-064, FR-065]
  Done when: SuperTokens email/password recipe configured; signup creates customer record; email verification required (unverified users get 403 on protected endpoints); login returns session tokens; integration tests: signup → verify email → login → access protected endpoint; unverified user blocked

- [ ] T033 Implement GitHub OAuth: link GitHub account [FR-068] [produces: IC-002]
  Done when: SuperTokens social login recipe configured for GitHub; "Link GitHub Account" endpoint associates GitHub user_id with customer record; integration test: create customer → link GitHub → verify github_user_id stored; duplicate link prevented

- [ ] T034 Implement admin auth + capability-based permissions [FR-077, FR-078, FR-080] [produces: IC-003]
  Done when: admin auth via separate SuperTokens recipe; admin_role and admin_user_role tables populated from seed; `requireCapability('orders.read')` middleware checks admin's role capabilities; 403 returned for insufficient permissions; integration tests: admin login → has permission → allowed; admin without permission → 403; permission matrix matches spec (orders.read, orders.refund, orders.cancel, inventory.read, inventory.adjust, etc.)

- [ ] T035 Implement admin_audit_log middleware [FR-079]
  Done when: Fastify hook on admin routes auto-creates audit_log entries with: actor_admin_user_id, action, entity_type, entity_id, before_json, after_json, ip_address, created_at; integration test: admin creates a product → audit log entry exists with correct before (null) and after (product JSON)

- [ ] T036 Implement guest order → account linking [FR-066]
  Done when: on email verification, query orders by `order.email` column (where customer_id IS NULL) and set customer_id to the new account; integration test: create 3 guest orders with email `jane@example.com` → create account with same email → verify email → all 3 orders appear in customer's order list; orders now have customer_id set

- [ ] T037 Update /ready to check SuperTokens connectivity [FR-103]
  Done when: /ready checks SuperTokens health endpoint; returns 503 if SuperTokens is down; integration test verifies

---

## Phase 5: Catalog + Inventory [FR-001 through FR-006, FR-032 through FR-038]

- [ ] T038 Implement product CRUD API (admin) [FR-001, FR-004, FR-005] [P]
  Done when: POST/GET/PATCH /admin/products; status transitions validated (draft→active→archived, archived is terminal); product media upload with sort_order and alt_text; collection CRUD with product-collection associations; permission check: `products.write` for mutations, `products.read` for reads; integration tests cover: create draft → activate → archive; media reorder; collection management

- [ ] T039 Implement product variant + classification API (admin) [FR-002, FR-003] [P]
  Done when: POST/PATCH /admin/products/:id/variants; variants have material axis (TPU/PA11/TPC), independent price_minor, sku, weight, dimensions; product_class CRUD; product_class_membership assignment; integration tests: create product → add TPU variant ($29.99) → add PA11 variant ($49.99) → assign to class "modules"; variant status transitions (draft→active→inactive→archived)

- [ ] T040 Implement inventory balance + adjustment API (admin) [FR-032, FR-033, FR-037, FR-038]
  Done when: GET /admin/inventory/balances with filters; POST /admin/inventory/adjustments with adjustment_type (restock/shrinkage/damage), quantity_delta, reason, notes; adjustment atomically updates on_hand and available; audit log entry created with actor; low-stock detection: when available < safety_stock, flag variant; inventory_movement ledger entry created for every adjustment; integration tests: restock +100 → verify balance; shrinkage -5 → verify; CHECK constraint prevents negative available

- [ ] T041 Implement inventory reservation system [FR-034, FR-035, FR-036]
  Done when: `inventoryService.reserve(variantId, locationId, quantity, ttl)` atomically increments reserved and decrements available using `SELECT ... FOR UPDATE`; `inventoryService.consume(reservationId)` decrements on_hand and reserved; `inventoryService.release(reservationId)` decrements reserved and increments available; reservation status machine: pending→active→consumed/released/expired; inventory_movement created for each operation; integration tests: reserve → consume; reserve → release; reserve → expire (TTL); concurrent reserve for last unit (one succeeds, one fails with ERR_INVENTORY_INSUFFICIENT)

- [ ] T042 Implement reservation cleanup cron [FR-034]
  Done when: cron job (configurable interval, default 1 min) finds reservations with status=active and expires_at < now(); releases each back to available; logs at INFO: "Released N expired reservations"; integration test: create reservation with 1s TTL → wait → verify released

- [ ] T043 Implement low-stock alert [FR-038]
  Done when: when inventory adjustment or reservation causes available < safety_stock, notification queued; alert includes variant SKU, product title, available count, safety_stock threshold; integration test: set safety_stock=10 → adjust available to 5 → verify alert queued

- [ ] T044 Implement public catalog API (no auth) [FR-001, FR-002] [produces: IC-009]
  Done when: GET /api/products returns active products with variants, media, pricing, availability; GET /api/products/:slug returns product detail with variant availability; response shape matches spec section 4; no auth required; products with status != active are excluded; integration tests: list products (only active), product detail with variants, out-of-stock variant flagged

- [ ] T045 Implement customer address CRUD API [FR-067]
  Done when: POST/GET/PATCH/DELETE /api/customer/addresses; addresses linked to customer_id; `is_default` flag with only-one-default constraint; US-only validation on address fields; integration tests: create address → set as default → update → delete; non-US address rejected

- [ ] T045a Critical path checkpoint (Phase 5) [Critical Path]
  Done when: integration test exercises: seed data → list products via public API → check inventory → reserve variant → release reservation → verify balance restored

---

## Phase 6: Cart + Checkout + Payments [FR-007 through FR-018, FR-019 through FR-031, FR-117 through FR-120]

- [ ] T046 Implement cart API [FR-012, FR-013, FR-014] [produces: IC-010]
  Done when: POST /api/cart (creates guest cart, returns `cart.token` UUID — distinct from `cart.id` PK for security); POST /api/cart/items (add variant, validate availability); DELETE /api/cart/items/:id; GET /api/cart (returns items with current prices + availability); guest carts looked up by `token` column via `X-Cart-Token` header; authenticated carts linked to customer_id; cart validates inventory on read (stale items flagged); integration tests: create guest cart → add items → verify totals; add out-of-stock item → rejected

- [ ] T047 Implement kit composition system [FR-007, FR-008, FR-009, FR-010, FR-011]
  Done when: kit_definition, kit_class_requirement, cart_kit_selection entities; POST /api/cart/kits (add kit to cart with selected variants per class); validation: all class requirements satisfied, all selected variants in stock and match class membership; kit price_minor stored on kit_definition (admin-set fixed price); UI shows savings vs individual; inventory reservation per component; integration tests: valid kit → added; incomplete kit → rejected with message "Select 2 more from Plates"; out-of-stock component → rejected with swap suggestion

- [ ] T048 Implement Stripe Tax adapter [FR-117, FR-118, FR-119, FR-120]
  Done when: `taxAdapter.calculate(lineItems, shippingAddress)` returns tax amount; production mode: calls Stripe Tax API when STRIPE_TAX_ENABLED=true and valid key; stub mode: returns 0 tax when STRIPE_TAX_ENABLED=false; tax included in Stripe PaymentIntent metadata; integration tests: (stub mode) tax = 0; (if Stripe test key available) tax calculated for TX address

- [ ] T049 Implement checkout flow [FR-012, FR-015, FR-016, FR-017, FR-018, FR-022, FR-023, FR-025, FR-026]
  Done when: POST /api/checkout: validates cart → creates inventory reservations (15 min TTL) → calculates shipping via EasyPost → calculates tax via Stripe Tax → creates Stripe PaymentIntent → creates order with status=pending_payment, payment_status=unpaid, `email` field set from checkout input → returns PaymentIntent client_secret; order_number generated as KNX-000001 format; order stores address snapshots + product/price snapshots on order_lines; US-only address validation (non-US → 400); integration tests: full checkout → order created with snapshots + email stored; non-US address rejected; inventory reserved

- [ ] T050 Implement order state machines [FR-019, FR-020, FR-021]
  Done when: four orthogonal state machines on order: status (draft→pending_payment→confirmed→completed→canceled→closed), payment_status, fulfillment_status, shipping_status; invalid transitions rejected with ERR_INVALID_TRANSITION; all transitions create order_status_history entry with actor/reason; unit tests: every valid transition succeeds; every invalid transition rejected; integration test: full order lifecycle

- [ ] T051 Implement Stripe webhook handler [FR-027, FR-028, FR-029, FR-031] [consumes: IC-004]
  Done when: POST /webhooks/stripe validates signature; idempotent: duplicate event processing is no-op (check payment_event.provider_event_id); handles: payment_intent.succeeded → payment_status=paid + reservation consumed; payment_intent.payment_failed → payment_status=failed + reservation released; charge.refunded → payment_status updated; charge.dispute.created → dispute record created; raw payload stored as payment_event; integration tests: success webhook → order confirmed; duplicate webhook → no-op; invalid signature → 401

- [ ] T052 Implement refund API (admin) [FR-030] [P]
  Done when: POST /admin/orders/:id/refunds with amount + reason; validates amount <= remaining refundable; creates Stripe refund; updates payment_status (paid→partially_refunded or refunded); audit log with actor; integration tests: full refund; partial refund; over-refund rejected with ERR_REFUND_EXCEEDS_PAYMENT

- [ ] T053 Implement order cancellation API (admin) [FR-024] [P]
  Done when: POST /admin/orders/:id/cancel with reason; validates: not shipped (ERR_ORDER_ALREADY_SHIPPED); releases inventory reservations; initiates full refund if paid; order.status → canceled; audit log; integration tests: cancel unpaid → reservations released; cancel paid → refund + reservations released; cancel shipped → rejected

- [ ] T054 Implement policy acknowledgment [FR-062, FR-063]
  Done when: checkout captures policy_snapshot_id for current warranty/returns/terms policies; order_policy_acknowledgment created linking order to policy version; policy_snapshot table with versioned content_html/content_text; integration test: checkout → acknowledgment record exists with correct policy version

- [ ] T054a Implement kit cart re-validation on definition change [FR-E005, FR-E006]
  Done when: when admin updates a kit_definition (class requirements or price), any active carts containing that kit are flagged; on next cart read, kit selections are re-validated against new definition; invalid selections show warning to customer; kit price recalculated at checkout from current kit_definition.price_minor (not cached); integration tests: add kit to cart → admin changes class requirement → cart read shows validation warning; price change reflected at checkout

- [ ] T054b Implement reservation expiry / payment race handler [FR-E008]
  Done when: when payment_intent.succeeded webhook fires and the order's reservations have been expired by the cleanup cron, the system either (a) re-reserves if stock is still available and confirms the order, or (b) flags the order for manual review with status=`pending_payment` and an admin alert; integration test: create reservation → force-expire it → fire payment success webhook → verify order flagged for review OR re-reserved

- [ ] T054c Implement idempotent inventory adjustments [FR-E009]
  Done when: POST /admin/inventory/adjustments accepts optional `idempotency_key` header; duplicate requests with the same key return the original result without creating a second adjustment; integration test: submit adjustment with key → submit same key again → verify only one adjustment record exists

- [ ] T054d Implement Stripe unreachable checkout error [FR-E012]
  Done when: when Stripe API is unreachable during PaymentIntent creation, checkout returns 502 with ERR_EXTERNAL_SERVICE_UNAVAILABLE and does NOT create an order; inventory reservations are released; integration test: mock Stripe timeout → verify 502 response + no order + reservations released

- [ ] T054e Implement duplicate email verification conflict detection [FR-E017]
  Done when: if a second account attempts to verify an email that is already verified by another account, verification is rejected with ERR_EMAIL_ALREADY_CLAIMED; admin alert created; integration test: account A verifies email → account B attempts to verify same email → rejected

- [ ] T055 Critical path checkpoint (Phase 6) [Critical Path]
  Done when: integration test exercises full checkout: seed products → create cart → add items → checkout → Stripe payment succeeds (test mode) → order confirmed → inventory consumed → snapshots stored → policy acknowledged

---

## Phase 7: Fulfillment + Shipping [FR-039 through FR-049]

- [ ] T056 Implement fulfillment task system [FR-039, FR-040, FR-041, FR-042, FR-042a]
  Done when: fulfillment_task auto-created when order.payment_status → paid; state machine: new→assigned→picking→picked→packing→packed→shipment_pending→done; blocked state for exceptions; assignment API with admin_user_id; validation: cannot start until payment_status=paid; next-day SLA: orders confirmed before configurable cutoff (default 2:00 PM local) get priority=`high` and flag `sla_at_risk` on dashboard; integration tests: payment succeeds → task created; walk task through full lifecycle; invalid transitions rejected; order before cutoff → high priority; order after cutoff → normal priority

- [ ] T057 Implement EasyPost adapter [FR-043, FR-049] [produces: IC-006]
  Done when: `shippingAdapter.getRates(fromAddress, toAddress, packages)` returns carrier rates; `shippingAdapter.buyLabel(rateId)` purchases label and returns tracking number + label URL; `shippingAdapter.getTracking(trackerId)` returns tracking status; adapter interface allows provider swap via config; integration tests (EasyPost test mode): get rates → buy label → verify tracking number returned

- [ ] T058 Implement shipment system [FR-044, FR-046, FR-047, FR-048]
  Done when: POST /admin/shipments creates draft shipment for order; shipment_package with weight/dimensions; shipment_line maps order_lines to shipment with quantities; POST /admin/shipments/:id/buy-label purchases via EasyPost adapter and records cost in shipping_label_purchase; shipment status machine: draft→label_pending→label_purchased→ready→shipped→in_transit→delivered; integration tests: create shipment → buy label → mark shipped

- [ ] T059 Implement tracking webhook handler [FR-045, FR-046] [consumes: IC-006]
  Done when: POST /webhooks/easypost processes tracking events; creates shipment_event records with status/description/occurred_at/raw_payload; updates shipment.status based on event; propagates to order.shipping_status; integration test: simulate tracking events → shipment status updates → order shipping_status updates

- [ ] T059a Implement shipment void-label API [FR-E027] [P]
  Done when: POST /admin/shipments/:id/void-label voids the label via EasyPost adapter; shipment.status → `voided`; refunds label cost if applicable; only valid for pre-ship statuses (draft, label_pending, label_purchased, ready); integration test: buy label → void → verify status=voided; attempt void on shipped → rejected

- [ ] T059b Implement shipment refresh-tracking API [P]
  Done when: POST /admin/shipments/:id/refresh-tracking fetches latest tracking from EasyPost adapter; creates any new shipment_event records not already stored; updates shipment.status if changed; integration test: shipped shipment → refresh → new events stored

- [ ] T059c Implement shipment mark-shipped API [P]
  Done when: POST /admin/shipments/:id/mark-shipped transitions shipment.status → `shipped`; records shipped_at timestamp; only valid from `ready` status; integration test: ready shipment → mark-shipped → status=shipped + shipped_at set

- [ ] T059d Implement order resend-confirmation API [P]
  Done when: POST /admin/orders/:id/resend-confirmation queues order confirmation notification (via notification service / email stub); rate-limited to prevent spam (max 1 per 5 minutes per order); integration test: resend → email logged to stub; rapid resend → rate limited

- [ ] T060 Implement fulfillment → shipping status propagation [FR-039, FR-044]
  Done when: when all shipment_lines for an order are in shipped/delivered shipments, order.fulfillment_status → fulfilled; when all shipments delivered, order.shipping_status → delivered; when fulfillment_status=fulfilled AND shipping_status=delivered, order.status can transition to completed; integration test: complete fulfillment → all shipped → delivered → order completable

---

## Phase 8: Support + Disputes + Evidence [FR-050 through FR-063]

- [ ] T061 Implement support ticket system [FR-050, FR-051, FR-052, FR-054]
  Done when: POST /api/support/tickets (customer) and POST /admin/support/tickets (admin); state machine: open→waiting_on_customer/waiting_on_internal→resolved→closed; message threading: POST /support/tickets/:id/messages (customer-visible) and POST /admin/support/tickets/:id/internal-notes (admin-only, is_internal_note=true); tickets linkable to order_id, shipment_id; integration tests: customer creates ticket → admin replies → internal note (not visible to customer) → resolve → close

- [ ] T061a Implement duplicate ticket detection [FR-E028]
  Done when: when a customer creates a ticket for an order that already has an open/waiting ticket from the same customer within 24 hours, the new ticket is created but flagged with `potential_duplicate=true` and linked to the existing ticket; admin sees flag in ticket queue; admin can merge or dismiss; integration test: create ticket for order → create second ticket for same order within 24h → second ticket flagged; tickets >24h apart → no flag

- [ ] T062 Implement ticket attachments [FR-053]
  Done when: POST /support/tickets/:id/attachments accepts JPEG/PNG/PDF up to 10MB, max 5 per message; stored via storage adapter (local filesystem dev, S3 prod); file access controlled: only ticket customer + admins; integration tests: upload valid file → accessible; upload invalid type → rejected; unauthorized access → 403

- [ ] T063 Implement warranty claim flow [FR-055]
  Done when: POST /api/support/warranty-claims with order_id, order_line_id, description; validates: order delivered, within 1-year warranty period (from delivered_at); creates support_ticket with category=warranty_claim, priority=high; if TPU heat deformation described, flags material limitation in response; integration tests: valid claim (11 months) → ticket created; expired claim (13 months) → rejected; TPU heat claim → flagged

- [ ] T064 Implement dispute auto-creation [FR-056, FR-057]
  Done when: charge.dispute.created webhook creates dispute record; payment_status → disputed; dispute state machine: opened→evidence_gathering→ready_to_submit→submitted→won/lost/accepted→closed; charge.dispute.closed webhook updates dispute outcome and payment_status (won → paid, lost → refunded); integration tests: dispute webhook → record created + payment_status=disputed; close webhook → status updated

- [ ] T065 Implement evidence auto-collection [FR-058, FR-059, FR-062]
  Done when: on shipment tracking event → evidence_record (type=`tracking_history`); on shipment delivery confirmation → evidence_record (type=`delivery_proof`); on support_ticket_message creation → evidence_record (type=`customer_communication`); on payment_event creation → evidence_record (type=`payment_receipt`); on order_policy_acknowledgment creation → evidence_record (type=`policy_acceptance`); evidence_record table: no UPDATE/DELETE grants for app user (immutability enforced at DB level); integration test: complete order lifecycle → verify all 5 evidence types created; attempt UPDATE on evidence_record → fails

- [ ] T066 Implement evidence bundle generation [FR-060, FR-061]
  Done when: POST /admin/disputes/:id/generate-bundle compiles all evidence_record entries for the dispute's order into a downloadable package; dispute_readiness_summary computed: `tracking_history_present`, `delivery_proof_present`, `customer_communication_present`, `policy_acceptance_present`, `payment_receipt_present`; bundle cannot be generated if readiness is incomplete (missing types flagged); integration tests: complete evidence → bundle generated; incomplete evidence → readiness summary shows gaps

---

- [ ] T066a Implement manual evidence attachment API
  Done when: POST /admin/disputes/:id/evidence allows admin to attach manual evidence (file upload or text); creates evidence_record with admin-specified type; file stored via storage adapter; integration test: upload manual evidence → record created; accessible via GET /admin/evidence/:id

- [ ] T066b Implement evidence browsing API
  Done when: GET /admin/evidence with filters (type, order_id, shipment_id, ticket_id, dispute_id); GET /admin/evidence/:id returns single record with download URL for file-based evidence; integration tests: filter by order → returns all evidence for that order; filter by type → returns matching records

- [ ] T066c Implement fulfillment edge case handling [FR-E013, FR-E023, FR-E024]
  Done when: fulfillment_task.status `blocked` transition available from any active state with required `reason` field; unblock transitions back to previous active state; if inventory discrepancy found during picking, admin can block task and trigger inventory adjustment; if task canceled after picking, auto-create inventory adjustment to return picked items to available stock; integration tests: picking → blocked (reason: missing_inventory) → adjustment → unblock → picking; cancel after picking → verify auto-adjustment returns items to available

- [ ] T066d Implement shipping edge cases [FR-E025, FR-E026, FR-E027]
  Done when: EasyPost label purchase failure returns clear error and shipment remains in `label_pending`; delivery_exception shipment_event creates admin alert; exception → in_transit recovery transition supported; void-label refunds/credits label cost if applicable; integration tests: simulate label failure → verify error + no status change; delivery exception → alert fired; exception recovery; void → cost credited

---

## Phase 9: Contributor / Royalty System [FR-069 through FR-076]

- [ ] T067 Implement contributor registry + design linking [FR-069, FR-070]
  Done when: contributor entity with github_username, github_user_id, customer_id (nullable), cla_accepted_at; contributor_design links contributor to product; POST /admin/contributors (create from CLA bot data); GET /admin/contributors/:id/designs; integration test: create contributor → link to product → verify association

- [ ] T068 Implement per-design sales tracking [FR-070]
  Done when: on order completion (order.status → completed), for each order_line, find contributor_design by product_id; increment sales count; create contributor_royalty entry with status=accrued if contributor has crossed 25-unit threshold; integration test: complete order with contributor-designed product → sales count incremented

- [ ] T069 Implement royalty calculation engine [FR-071, FR-072, FR-076]
  Done when: when a contributor's cumulative sales for a design cross 25 units, royalty entries are created retroactively for units 1-25 at 10% of unit_price_minor; subsequent sales auto-create royalty entries; 501(c)(3) donation option at 2x rate (20%) with charity_name and charity_ein; refund clawback: contributor_royalty status → clawed_back; integration tests: 25th sale triggers retroactive royalty for 1-25; 26th sale creates single royalty; refund → clawback; donation at 20%

- [ ] T070 Implement milestone tracking + tax documents [FR-073, FR-074]
  Done when: contributor_milestone tracks: accepted_pr, royalty_activation (25 units), starter_kit (50 units); milestones auto-detected on sales; tax document upload: POST /api/contributors/tax-documents with W-9/W-8BEN file; storage via adapter; approval workflow (admin reviews); payout blocked until tax doc approved; integration tests: milestone progression; tax doc upload + approval; payout blocked without approved doc

- [ ] T071 Implement contributor dashboard API [FR-075]
  Done when: GET /api/contributors/dashboard (requires linked GitHub account) returns: designs contributed, per-design sales counts, royalty accrual (total, paid, pending), milestone progress, payout history; integration test: contributor with 30 sales → dashboard shows correct totals

---

## Phase 10: Notifications + Real-Time [FR-081 through FR-087]

- [ ] T071a Implement admin dashboard summary API
  Done when: GET /admin/dashboard/summary returns `{ordersAwaitingFulfillment, openSupportTickets, lowStockVariants, openDisputes, shipmentsWithExceptions}`; counts computed from current DB state; GET /admin/dashboard/alerts returns actionable alerts (expiring reservations, disputes nearing due_by, cert expiry warnings); integration tests: seed data with known counts → verify summary matches

- [ ] T071b Implement admin customer detail APIs
  Done when: GET /admin/customers with search/filter; GET /admin/customers/:id returns profile + stats; GET /admin/customers/:id/orders returns customer's orders; GET /admin/customers/:id/tickets returns customer's tickets; integration tests: create customer with orders and tickets → verify all sub-resource endpoints return correct data

- [ ] T071c Implement admin settings APIs [P]
  Done when: GET /admin/settings/shipping returns shipping config (default carrier, service levels, label settings); PATCH /admin/settings/shipping updates config; permission: `admin.settings.manage`; integration test: read → update → read → verify change persisted

- [ ] T072 Implement WebSocket server with auth [FR-081, FR-082, FR-083] [produces: IC-008]
  Done when: @fastify/websocket configured; WebSocket upgrade validates token (admin session, customer session, or cart token); authenticated connections subscribe to relevant entity channels; message format: `{type, entity, entityId, data, sequenceId}`; automatic reconnection guidance (client uses exponential backoff); integration tests: admin connects → receives events; unauthenticated → rejected; guest with cart token → receives cart/order events only

- [ ] T073 Implement server-side message buffering [FR-083]
  Done when: server buffers messages per connection for up to 5 minutes on disconnect; on reconnect, client sends lastSequenceId; server replays missed messages; integration test: connect → receive message (seq 1) → disconnect → new message sent (seq 2) → reconnect with lastSequenceId=1 → receive seq 2

- [ ] T074 Implement pub/sub for domain events [FR-081, FR-082]
  Done when: domain events (order.placed, payment.succeeded, shipment.delivered, ticket.updated, inventory.low_stock, dispute.opened) publish to WebSocket subscribers; admin gets all events; customer gets events for their orders/tickets; integration test: admin connected → create order → admin receives order.placed event within 2 seconds

- [ ] T075 Implement notification service + email stub [FR-084, FR-085, FR-086, FR-087]
  Done when: notification service dispatches via adapters: email (stubbed — logs to file), push (stubbed), in-app (via WebSocket); email adapter interface: `send(to, subject, body, templateId)`; stub writes to `logs/emails.jsonl`; admin alert preferences: per-admin config for push/email/both; integration test: trigger low-stock alert → admin with email preference → email logged to file; admin with push preference → WebSocket message received

---

## Phase 11: Flutter Admin App Shell [Admin route map]

- [ ] T076 Initialize Flutter admin app with Riverpod + Dio + GoRouter [P]
  Done when: `flutter run` launches admin app; GoRouter configured with route groups from spec (dashboard, orders, fulfillment, shipments, inventory, products, support, disputes, customers, settings); Riverpod providers for auth state; Dio configured with base URL + auth interceptor; admin login screen works against SuperTokens

- [ ] T077 Implement admin dashboard screen
  Done when: dashboard shows operational counts (orders awaiting fulfillment, open tickets, low stock variants, open disputes, shipment exceptions); counts fetched from GET /admin/dashboard/summary; quick links to filtered views; widget tests verify layout and data display

- [ ] T078 Implement admin order management screens
  Done when: order list with filters (status, payment, fulfillment, shipping, date range, search); order detail with tabs (summary, items, payment, fulfillment, shipping, support, evidence, audit); refund and cancel actions with confirmation dialogs; real-time updates via WebSocket; widget tests for list and detail

- [ ] T079 Implement admin fulfillment + shipment screens
  Done when: fulfillment task queue with assignment; pick/pack workflow screens; shipment creation, label purchase, tracking view; real-time queue updates; widget tests

- [ ] T080 Implement admin inventory + product screens
  Done when: inventory overview with low-stock highlighting; variant balance detail; adjustment creation; product CRUD with variant/media/classification management; widget tests

- [ ] T081 Implement admin support + dispute screens
  Done when: ticket queue with filters; ticket detail with message thread + internal notes; dispute detail with evidence readiness, bundle generation; widget tests

- [ ] T082 Implement admin settings + contributor management screens
  Done when: admin user management; role/permission configuration; contributor list with royalty status; widget tests

---

## Phase 12: Flutter Customer App Shell [Customer requirements]

- [ ] T083 Initialize Flutter customer app with Riverpod + Dio + GoRouter [P]
  Done when: `flutter run` launches customer app; GoRouter configured with routes (catalog, product detail, cart, checkout, orders, support, warranty, account, contributor dashboard); auth flow: signup → email verification → login; GitHub OAuth link in account settings; Dio configured with auth interceptor

- [ ] T084 Implement catalog + product detail screens
  Done when: product grid/list with images, pricing, availability; product detail with material variant selector (TPU/PA11/TPC); material-specific warranty info displayed; add to cart button; widget tests

- [ ] T085 Implement kit builder screen
  Done when: kit selection UI: shows class requirements (e.g., "Pick 2 Plates"), available products per class, in-stock indicator; validates all classes satisfied; shows kit price + savings vs individual; add kit to cart; widget tests

- [ ] T086 Implement cart + checkout screens
  Done when: cart with item list, quantity adjustment, remove; checkout: saved address selection or new address entry; shipping rate display (from EasyPost); tax display; Stripe payment (using Stripe SDK for Flutter); order confirmation; widget tests

- [ ] T087 Implement order history + tracking screens
  Done when: order list with status badges; order detail with timeline (status changes); shipment tracking with carrier events; real-time updates via WebSocket; widget tests

- [ ] T088 Implement support + warranty screens
  Done when: create ticket; message thread with attachments; file warranty claim (select order → describe defect → upload photos); warranty period validation shown to user; widget tests

- [ ] T089 Implement contributor dashboard screen
  Done when: visible only when GitHub account linked; shows designs, per-design sales, royalty accrual, milestone progress (with visual progress bars), payout history; widget tests

---

## Phase 13: Astro Site Evolution [FR-088 through FR-092]

- [ ] T090 Implement SSG product catalog pages [FR-088] [P]
  Done when: Astro generates static product listing page from API data at build time; product detail pages with variants, pricing, media, material warnings; SEO metadata (title, description, OpenGraph); existing STL viewer preserved for 3D model products

- [ ] T091 Implement guest checkout as Astro islands [FR-089, FR-012a] [consumes: IC-009, IC-010]
  Done when: checkout UI as client-side Astro islands; cart stored via cart_token in localStorage; email + address form; Stripe Elements for payment; shipping rate selection; tax display; order confirmation page; US-only address validation; integration test: full guest checkout flow

- [ ] T092 Implement kit builder page [FR-007, FR-088]
  Done when: Astro page with client-side kit builder island; class requirements displayed; product selection per class; availability checking; price + savings display; add to cart integration

- [ ] T093 Add contributions model page [FR-090] [P]
  Done when: Astro page describing contributor incentives: milestones table, royalty structure, CLA process, donation option; linked from README

- [ ] T094 Add warranty, returns, and care instructions pages [FR-091, FR-092] [P]
  Done when: warranty page with material-specific disclaimers (TPU heat >60°C, TPC 130°C rating); returns policy (30 days, conditions); safety disclaimer; care instructions per material tier; pages linked from footer and product detail pages

- [ ] T095 Update README with contributions model
  Done when: README includes contributions model table (milestones + rewards), link to Astro contributions page, CLA instructions

---

## Phase 14: Integration + E2E [SC-001 through SC-018]

- [ ] T096 E2E: guest checkout on Astro [SC-001]
  Done when: Playwright test: navigate to product → select variant → add to cart → checkout with email + address → pay via Stripe test → order confirmation displayed; completes in <3 minutes; order exists in DB with correct snapshots

- [ ] T097 E2E: authenticated checkout on Flutter [SC-001]
  Done when: flutter integration test: login → browse catalog → add to cart → checkout with saved address → pay → order appears in history with real-time status

- [ ] T098 E2E: kit purchase [SC-010]
  Done when: test: configure starter kit (2 plates + 3 modules + 1 belt) → checkout → verify each component reserved individually → payment → order with 6 line items

- [ ] T099 E2E: full fulfillment + shipping [SC-005, SC-006]
  Done when: test: order → fulfillment task → pick → pack → create shipment → buy label (EasyPost test) → mark shipped → tracking events → delivered → evidence records exist for every step → audit log complete

- [ ] T100 E2E: dispute lifecycle [SC-005]
  Done when: test: delivered order → simulate charge.dispute.created webhook → dispute created → evidence bundle generated with all types (tracking, delivery, customer comms, policy) → submit → close

- [ ] T101 E2E: contributor royalty [SC-011]
  Done when: test: create contributor → link design → complete 25 orders → verify retroactive royalty for units 1-25 → refund 1 order → verify clawback → donation option at 20%

- [ ] T102 E2E: concurrent inventory [SC-003]
  Done when: test: 1 unit available → 10 concurrent checkout attempts → exactly 1 succeeds → 9 fail with ERR_INVENTORY_INSUFFICIENT → available = 0

- [ ] T103 E2E: WebSocket real-time [SC-007]
  Done when: test: admin WebSocket connected → create order via API → admin receives order.placed within 2 seconds; customer connected → shipment status change → customer receives update within 2 seconds

- [ ] T104 Security boundary tests [SC-008, SC-015]
  Done when: test: unauthenticated → 401 on all protected endpoints; wrong permission → 403; SQL injection attempts → rejected; XSS in input → sanitized; invalid webhook signature → rejected

- [ ] T105 Create/verify UI_FLOW.md for admin and customer apps
  Done when: UI_FLOW.md documents all screens, routes, state machines, API calls, field validations, and real-time connections for both Flutter apps and Astro checkout; every flow has a corresponding E2E test reference

---

## Phase 15: Infrastructure + Deploy [FR-093 through FR-097]

- [ ] T106 Write OpenTofu configurations [FR-093, FR-094]
  Done when: `deploy/tofu/` provisions: server(s), Cloudflare DNS records, networking; `tofu plan` from fresh state shows create-only; `tofu apply` provisions infrastructure; variables for all configurable values

- [ ] T107 Write NixOS server modules [FR-095, FR-096]
  Done when: `deploy/nixos/` modules: api-server (Fastify as systemd service), postgres (with auth, logging, daily backup), nginx (reverse proxy, Let's Encrypt, WebSocket upgrade, security headers), supertokens (as service), common (firewall, SSH hardening); modules compose into a complete server config

- [ ] T108 Write Nix VM tests [FR-097]
  Done when: `deploy/tests/test-*.nix` validate per TEST-METHODOLOGY.md: service binding (correct ports/interfaces), firewall rules (allowed + denied), TLS config (no weak ciphers), Postgres access control, Nginx proxy behavior; `nix build .#checks.x86_64-linux.<test>` passes for all tests

- [ ] T109 Configure CI/CD deploy pipeline [needs: gh]
  Done when: `.github/workflows/deploy.yml` runs on main push after tests pass; builds API, builds site, deploys to server; rollback on failure; environment secrets configured

---

## Phase 16: Operations Runbook + Final Validation [FR-102]

- [ ] T110 Write RUNBOOK.md [FR-102]
  Done when: RUNBOOK.md documents: day-1 developer setup, day-2 ops with cadence (DB backups daily, vacuum weekly, dep updates weekly, cert monitoring, inventory cleanup, Stripe health, log rotation), failure recovery per component (Postgres down, Stripe webhook failures, SuperTokens unreachable, EasyPost errors), escalation procedures, Liquibase rollback procedures, OpenTofu plan/apply workflow

- [ ] T111 Final security scan + vulnerability review [SC-008]
  Done when: full security scan (Trivy + Semgrep + Gitleaks + npm audit) passes with zero critical findings; SARIF uploaded to GitHub Security tab; any findings documented with justification or fix

- [ ] T112 Final E2E validation of all user flows
  Done when: all SC-001 through SC-018 validated; all E2E tests from Phase 14 pass; UI_FLOW.md verified against implementation; no BLOCKED.md files remaining

- [ ] T113 Documentation review
  Done when: README complete with contributions model; CLAUDE.md up to date with all scripts and structure; RUNBOOK.md reviewed; API documentation generated; warranty/returns pages accurate
