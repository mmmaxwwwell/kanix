# Test Methodology & Misconfiguration Taxonomy

This document is the authoritative specification for what must be tested across the Kanix project. It covers infrastructure (Nix/NixOS configuration), backend services (Fastify API), admin application (Flutter), and cross-cutting security concerns.

**Agent instruction:** When configuration, schema, API, or infrastructure files change, read this document, read the diff, determine which test classes are affected, and update/add/remove tests accordingly. Every test assertion must trace back to a rule in this document.

---

## 1. Testing Methodology

### 1.1 Test Tiers

Tests are organized into four tiers by execution cost and feedback speed:

| Tier | Method | Speed | What it catches |
|------|--------|-------|-----------------|
| **Eval** | Nix evaluation, TypeScript type checking, JSON schema validation | Seconds | Type errors, missing options, referential integrity, config consistency |
| **Unit** | Vitest (backend), Flutter test (admin), isolated function tests | Seconds | Logic errors, state machine violations, pure function correctness |
| **Integration** | Real Postgres, real Stripe test mode, real SuperTokens, NixOS VM tests | Minutes | Service startup, API contracts, database constraints, auth flows, firewall behavior |
| **Scan** | Dependency audit, secret detection, SBOM generation, static analysis | Minutes | CVEs, supply chain issues, secrets in git, license compliance |

Every change must be tested at all applicable tiers.

### 1.2 Test Derivation Process

When a file changes, determine:

1. **What changed**: which domain, which module, which entities/endpoints
2. **Map to test classes**: use Section 2 below to find every applicable class
3. **Derive concrete assertions**: using the changed values, generate specific test checks
4. **Check cross-references**: if the changed value is referenced by other modules, test those too
5. **Update test implementations**: modify test files
6. **Run affected tests**: verify the changes pass

### 1.3 Coverage Rules

These rules are non-negotiable:

- **Every API endpoint must have a test** asserting correct request/response, authentication, authorization, and error cases
- **Every state machine transition must have a test** asserting valid transitions succeed and invalid transitions are rejected
- **Every database constraint must have a test** asserting it enforces correctness (unique, foreign key, check constraints)
- **Every listening port must have a test** asserting it is expected, on the correct interface, accessible only from authorized sources
- **Every firewall rule must have a test** asserting it works (both allow and deny)
- **Every service must have a test** asserting it starts, binds correctly, and is reachable from intended clients
- **Every secret/credential must have a test** asserting correct permissions, rotation capability, and no plaintext exposure
- **Every admin action must have a test** asserting audit log creation with correct actor attribution
- **Negative tests are mandatory**: for every "X succeeds" test, there must be a corresponding "X fails when unauthorized/invalid" test

### 1.4 Test Naming Convention

```
Backend:    tests/<domain>/<entity-or-flow>.test.ts
Nix:        tests/nix/test-<category>-<specific>.nix
Flutter:    test/<domain>/<widget-or-flow>_test.dart
Integration: tests/integration/<flow>.test.ts
```

Domains: `orders`, `payments`, `inventory`, `fulfillment`, `shipments`, `support`, `disputes`, `evidence`, `products`, `customers`, `admin`, `auth`, `config`, `infra`

---

## 2. Test Classes

### Class 1: Nix Evaluation Integrity

**What:** Nix configurations fail to evaluate — type errors, missing attributes, flake composition failures.

**When to test:** Every change to any `.nix` file or `flake.nix`/`flake.lock`.

**How to test:** Eval tier. `nix flake check`, `nix develop --command true` for each sub-flake.

**Specific checks:**
- Root flake composes all sub-flakes without evaluation errors
- Each sub-flake (`site/`, `scad/`, backend, admin) evaluates independently
- DevShell provides all expected tools for each domain
- No circular dependencies between flakes
- `flake.lock` is committed and matches `flake.nix`
- All flake inputs are pinned with integrity hashes

---

### Class 2: State Machine Correctness

**What:** A state transition is allowed that shouldn't be, or a valid transition is rejected.

**When to test:** Any change to order, payment, fulfillment, shipping, inventory reservation, support ticket, or dispute status handling.

**How to test:** Unit tier (pure state machine logic) + Integration tier (database-enforced transitions).

**Specific checks per state machine:**

For EVERY state machine in the system, assert:
- Every valid transition succeeds and produces the correct new state
- Every invalid transition is rejected with a descriptive error
- Terminal states cannot transition to any other state
- State changes create audit log entries with actor attribution
- Orthogonal state dimensions (order.status, payment_status, fulfillment_status, shipping_status) do not produce impossible combinations

**State machine inventory (update when state machines change):**

| Entity | Status Field | States | Defined in spec section |
|--------|-------------|--------|------------------------|
| order | status | draft, pending_payment, confirmed, completed, canceled, closed | 3.A.1 |
| order | payment_status | unpaid, processing, paid, partially_refunded, refunded, failed, disputed | 3.A.2 |
| order | fulfillment_status | unfulfilled, queued, picking, packing, ready_to_ship, partially_fulfilled, fulfilled, canceled | 3.A.3 |
| order | shipping_status | not_shipped, label_pending, label_purchased, shipped, in_transit, out_for_delivery, delivered, delivery_exception, returned, canceled | 3.A.4 |
| inventory_reservation | status | pending, active, consumed, released, expired, canceled | 3.B |
| support_ticket | status | open, waiting_on_customer, waiting_on_internal, resolved, closed, spam | 3.C |
| fulfillment_task | status | new, assigned, picking, picked, packing, packed, shipment_pending, done, blocked, canceled | 3.D |
| shipment | status | draft, label_pending, label_purchased, ready, shipped, in_transit, delivered, exception, returned, voided | 3.E |
| dispute | status | opened, evidence_gathering, ready_to_submit, submitted, won, lost, accepted, closed | 3.F |
| product | status | draft, active, archived | 3.G |
| product_variant | status | draft, active, inactive, archived | 3.G |

---

### Class 3: Database Constraint Enforcement

**What:** A database constraint is missing, wrong, or bypassable — allowing invalid data.

**When to test:** Any change to schema, migrations, or entity definitions.

**How to test:** Integration tier against real Postgres.

**Specific checks:**
- Unique constraints: `(variant_id, location_id)` on inventory_balance, `order_number` on order, `sku` on product_variant, `slug` on product, etc.
- Foreign key constraints: every `_id` reference resolves to an existing parent row
- Check constraints: `on_hand >= 0`, `reserved >= 0`, `available >= 0`, `price_minor > 0`, quantities positive
- NOT NULL constraints: all required fields reject null insertion
- Cascade behavior: deleting a parent does NOT silently delete children (prefer RESTRICT over CASCADE for financial data)
- Attempt to insert duplicate violates unique → returns descriptive error
- Attempt to reference nonexistent foreign key → returns descriptive error

---

### Class 4: API Contract Compliance

**What:** An API endpoint returns the wrong shape, status code, or headers.

**When to test:** Any change to route handlers, request/response schemas, or middleware.

**How to test:** Integration tier against running Fastify server with real Postgres.

**Specific checks per endpoint:**
- Request body validation: missing required fields → 400, extra fields → stripped or 400, wrong types → 400
- Response shape matches documented JSON schema exactly
- Pagination: `page`, `pageSize`, `total` fields present and correct
- Authentication: unauthenticated requests → 401
- Authorization: insufficient permissions → 403
- Not found: invalid IDs → 404
- Conflict: duplicate creation → 409
- Correct HTTP status codes for success (200, 201, 204)
- Security headers present on every response (HSTS, X-Frame-Options, X-Content-Type-Options, CSP)
- CORS headers match configured allowed origins (not `*`)
- Rate limiting headers present (X-RateLimit-Limit, X-RateLimit-Remaining, Retry-After on 429)

---

### Class 5: Authentication & Authorization

**What:** A request is processed without proper auth, or a user accesses resources beyond their permissions.

**When to test:** Any change to auth middleware, role definitions, permission checks, or SuperTokens config.

**How to test:** Integration tier.

**Specific checks:**
- Every admin endpoint rejects unauthenticated requests
- Every admin endpoint checks capability permissions, not just role membership
- Admin user with `orders.read` can list orders but cannot refund (requires `orders.refund`)
- Admin user with no roles gets 403 on all protected endpoints
- Expired session tokens are rejected
- Customer auth tokens cannot access admin endpoints
- Admin auth tokens cannot access customer-facing endpoints (separation of concerns)
- SuperTokens session refresh works correctly
- Password/credential rotation doesn't break active sessions (or does, intentionally, with documentation)

**Permission matrix (update when permissions change):**

| Endpoint | Required Permission |
|----------|-------------------|
| `GET /admin/orders` | `orders.read` |
| `POST /admin/orders/:id/refunds` | `orders.refund` |
| `POST /admin/orders/:id/cancel` | `orders.cancel` |
| `POST /admin/inventory/adjustments` | `inventory.adjust` |
| `POST /admin/shipments/:id/buy-label` | `shipments.buy_label` |
| `POST /admin/disputes/:id/generate-bundle` | `disputes.submit` |
| `POST /admin/support/tickets/:id/internal-notes` | `support.internal_note` |
| `POST /admin/users/:id/roles` | `admin.roles.manage` |

---

### Class 6: Inventory Atomicity

**What:** A race condition allows overselling, double-reserving, or negative stock.

**When to test:** Any change to inventory reservation, balance calculation, or order placement logic.

**How to test:** Integration tier with concurrent test scenarios against real Postgres.

**Specific checks:**
- Concurrent reservation attempts for the last available unit: exactly one succeeds, the other gets a stock error
- Reservation creation atomically decrements `available` (via `reserved` increment)
- Reservation consumption atomically decrements `on_hand` and `reserved`
- Reservation release/expiry atomically increments `available` (via `reserved` decrement)
- `available` never goes negative (database CHECK constraint)
- `reserved` never exceeds `on_hand` (database CHECK constraint)
- Expired reservations are cleaned up and stock is returned to available pool
- Shipment creation validates against reserved quantities — cannot ship more than reserved

---

### Class 7: Evidence Chain Integrity

**What:** Evidence records are missing, incomplete, or disconnected from their source entities.

**When to test:** Any change to evidence creation, shipment events, support interactions, payment events, or policy snapshots.

**How to test:** Integration tier.

**Specific checks:**
- Every shipment delivery event auto-creates an evidence record
- Every support ticket message auto-creates an evidence record
- Every payment event auto-creates an evidence record
- Every policy acknowledgment auto-creates an evidence record
- Evidence bundle generation collects all evidence records for a dispute's order
- Evidence bundle includes: shipping proof (tracking + delivery), customer communications, payment history, policy snapshots
- Evidence records are immutable — no updates, no deletes
- Evidence records reference their source entity (order, payment, shipment, ticket, dispute)
- Missing evidence for a dispute is flagged (dispute readiness summary shows gaps)

---

### Class 8: Snapshot Correctness

**What:** Order data references mutable current data instead of point-in-time snapshots.

**When to test:** Any change to order creation, order line creation, or address handling.

**How to test:** Integration tier.

**Specific checks:**
- `order_line` stores `sku_snapshot`, `title_snapshot`, `option_values_snapshot_json`, `unit_price_minor` at time of order placement
- Changing the product variant's price/title/sku AFTER order placement does NOT affect the order line
- `order` stores `billing_address_snapshot_json` and `shipping_address_snapshot_json` at time of placement
- Changing or deleting the customer's address AFTER order placement does NOT affect the order
- Policy acknowledgments reference a `policy_snapshot_id` — changing the policy text creates a new snapshot, doesn't mutate the old one

---

### Class 9: Audit Trail Completeness

**What:** A privileged admin action is not logged, or the log is missing required fields.

**When to test:** Any change to admin action handlers or audit logging middleware.

**How to test:** Integration tier.

**Specific checks:**
- Every refund action creates an audit log entry with actor, before/after state, and IP
- Every inventory adjustment creates an audit log entry
- Every role change creates an audit log entry
- Every order cancellation creates an audit log entry
- Every policy update creates an audit log entry
- Audit log entries are immutable — no updates, no deletes
- Audit log entries include: `actor_admin_user_id`, `action`, `entity_type`, `entity_id`, `before_json`, `after_json`, `ip_address`, `created_at`
- Bulk operations create individual audit entries per affected entity

---

### Class 10: Service Configuration & Binding

**What:** A service listens on the wrong address/port or accepts connections from unauthorized sources.

**When to test:** Any change to server configuration, Nix service definitions, or network setup.

**How to test:** Nix VM tier for infrastructure, integration tier for application services.

**Specific checks:**
- Fastify binds to configured address only (not 0.0.0.0 in production)
- Postgres accepts connections only from application server, not from public internet
- SuperTokens core binds to localhost only
- Stripe webhooks are validated with signing secret
- Health check endpoints are accessible without authentication
- Admin endpoints are NOT accessible without authentication
- No unexpected ports open on any server (compare `ss -tlnp` against allowlist)

---

### Class 11: Supply Chain & Dependency Security

**What:** Unpinned dependencies, known CVEs, unsigned packages, secrets in git.

**When to test:** Any change to `flake.nix`, `flake.lock`, `package.json`, `package-lock.json`, `pubspec.yaml`, `pubspec.lock`.

**How to test:** Scan tier.

**Specific checks:**
- All Nix flake inputs are pinned in `flake.lock`
- `npm audit` reports no critical or high vulnerabilities
- `flutter pub outdated` shows no packages with known CVEs
- No secrets in git history (`git log --all -p -- '*.key' '*.pem' '*.secret' '*.env'`)
- No plaintext credentials in any source file
- All `fetchTarball`/`fetchurl`/`fetchFromGitHub` calls have integrity hashes
- nixpkgs pin is less than 90 days old
- `npm install --ignore-scripts` is used (postinstall scripts disabled)
- SBOM generated for every deployment artifact

---

### Class 12: Stripe Integration Correctness

**What:** Payment processing logic mishandles Stripe events, amounts, or idempotency.

**When to test:** Any change to payment handling, webhook processing, or refund logic.

**How to test:** Integration tier against Stripe test mode.

**Specific checks:**
- Payment intent creation uses correct amount and currency
- Webhook signature verification rejects tampered payloads
- Duplicate webhook delivery is idempotent (same event processed once)
- `payment_intent.succeeded` → order payment_status becomes `paid`
- `payment_intent.payment_failed` → order payment_status becomes `failed`
- `charge.dispute.created` → dispute record created, payment_status becomes `disputed`
- Refund amount cannot exceed original payment amount
- Partial refund correctly updates payment_status to `partially_refunded`
- Full refund correctly updates payment_status to `refunded`
- All Stripe API calls use idempotency keys

---

## 3. Cross-Cutting Concerns

### 3.1 Negative Test Derivation

For every positive assertion, derive the corresponding negative assertion:

| Positive | Negative |
|----------|----------|
| Admin with `orders.read` can list orders | Admin without `orders.read` gets 403 |
| Valid state transition succeeds | Invalid state transition returns error |
| Reservation for available stock succeeds | Reservation for unavailable stock fails |
| Authenticated request succeeds | Unauthenticated request gets 401 |
| Webhook with valid signature is processed | Webhook with invalid signature is rejected |
| Evidence bundle generates for complete dispute | Incomplete evidence is flagged in readiness summary |
| Correct Stripe amount processes | Mismatched amount is rejected |

### 3.2 Referential Integrity

When a shared value changes, trace every reference across the system:

```
product_variant.id → inventory_balance.variant_id
                   → inventory_reservation.variant_id
                   → order_line.variant_id
                   → inventory_adjustment.variant_id
                   → inventory_movement.variant_id

order.id → order_line.order_id
         → payment.order_id
         → shipment.order_id
         → fulfillment_task.order_id
         → support_ticket.order_id
         → inventory_reservation.order_id
         → evidence_record.order_id
         → order_status_history.order_id
         → order_policy_acknowledgment.order_id

payment.id → payment_event.payment_id
           → refund.payment_id
           → dispute.payment_id
           → evidence_record.payment_id
```

### 3.3 Full System Integration Test

After testing individual components, run a full end-to-end flow:
1. Create product with variants
2. Set inventory balances
3. Customer creates cart, begins checkout
4. Inventory reservation created
5. Payment succeeds via Stripe
6. Reservation consumed, inventory decremented
7. Fulfillment task created and progressed
8. Shipment created, label purchased, marked shipped
9. Tracking events received, delivery confirmed
10. Evidence records exist for every step
11. Support ticket created and resolved
12. Dispute opened, evidence bundle generated
13. All audit logs present with correct actor attribution

---

## 4. Change-Driven Test Update Procedure

### Step 1: Classify the change
Read the diff. For each changed file, identify:
- Which domain(s) are affected
- Which test class(es) apply (Section 2)
- Which cross-cutting concerns apply (Section 3)

### Step 2: Check existing tests
For each applicable test class:
- Does a test already exist?
- Does the existing test cover the new/changed value?
- Are the expected values still correct?

### Step 3: Update tests
For each gap:
- Test exists but wrong expected values → update assertions
- Test exists but doesn't cover new code path → add assertions
- No test exists for this class → create new test
- Code removed → remove corresponding test assertions

### Step 4: Run affected tests
```bash
# Backend unit/integration
cd api && npm test -- --filter <affected>

# Nix evaluation
nix flake check

# Nix VM tests
nix build .#checks.x86_64-linux.<affected-test> -L

# Flutter tests
cd admin && flutter test test/<affected>

# Security scan
npm audit && git secrets --scan
```

---

## 5. Adding a New API Endpoint

When a new endpoint is added:

1. Add request/response schema validation test (Class 4)
2. Add authentication test — unauthenticated → 401 (Class 5)
3. Add authorization test — wrong permissions → 403 (Class 5)
4. Add happy path test with correct data
5. Add error path tests: invalid input → 400, not found → 404, conflict → 409
6. Add audit log test if the endpoint performs a privileged write (Class 9)
7. Add rate limiting test if applicable
8. Update the permission matrix in this document
9. Add to SBOM/security scan scope

## 6. Adding a New State Machine

When a new state machine is added:

1. Add transition tests for every valid transition (Class 2)
2. Add rejection tests for every invalid transition (Class 2)
3. Add terminal state tests — cannot transition out (Class 2)
4. Add audit log tests for state changes (Class 9)
5. Add database constraint tests (Class 3)
6. Update the state machine inventory table in this document

## 7. Adding a New Entity

When a new database entity is added:

1. Add unique constraint tests (Class 3)
2. Add foreign key constraint tests (Class 3)
3. Add NOT NULL constraint tests (Class 3)
4. Add check constraint tests (Class 3)
5. Add API CRUD tests if the entity has endpoints (Class 4)
6. Add auth/permission tests for its endpoints (Class 5)
7. Add referential integrity diagram update (Section 3.2)
8. Add to the full system integration test if applicable (Section 3.3)
