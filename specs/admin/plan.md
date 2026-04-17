# Implementation Plan: Kanix Commerce Platform

**Created**: 2026-04-16
**Spec**: `specs/admin/spec.md`
**Preset**: Enterprise
**Constitution**: `.specify/memory/constitution.md`

---

## Technology Stack Summary

| Component | Technology | Nix Package |
|-----------|-----------|-------------|
| Backend runtime | Node.js 22 LTS | `nodejs_22` |
| Backend framework | Fastify 5 + TypeScript 5.x (strict) | via pnpm |
| ORM | Drizzle ORM | via pnpm |
| Database | PostgreSQL 16 | `postgresql_16` |
| Migrations | Liquibase | `liquibase` |
| Package manager | pnpm | `pnpm_10` |
| WebSocket | @fastify/websocket | via pnpm |
| Auth | SuperTokens (self-hosted) | `supertokens-core` or Docker |
| Payments | Stripe (Node SDK) | via pnpm |
| Tax | Stripe Tax | via Stripe SDK |
| Shipping | EasyPost (Node SDK) | via pnpm |
| Public site | Astro 6.x | via pnpm |
| Customer app | Flutter 3.x + Dart | `flutter` |
| Admin app | Flutter 3.x + Dart | `flutter` |
| State management | Riverpod | via pub |
| HTTP client (Flutter) | Dio | via pub |
| IaC | OpenTofu | `opentofu` |
| DNS | Cloudflare (via OpenTofu provider) | via OpenTofu |
| TLS | Let's Encrypt + Nginx | `nginx`, `certbot` |
| Logging | Pino (Fastify built-in) | via pnpm |
| Test runner (backend) | Vitest | via pnpm |
| Test runner (Flutter) | flutter test | via Flutter SDK |
| Linter (backend) | ESLint + Prettier | via pnpm |
| Linter (Flutter) | dart analyze + dart format | via Flutter SDK |
| Security scanning | Trivy, Semgrep, Gitleaks | `trivy`, `semgrep`, `gitleaks` |
| Process orchestration (dev) | process-compose | `process-compose` |
| 3D models | OpenSCAD + BOSL2 | `openscad-unstable` |

### Tool Environment Inventory

| Command | Tool | Nix Package | Notes |
|---------|------|-------------|-------|
| `pnpm install` | pnpm | `pnpm_10` | In nixpkgs |
| `pnpm vitest` | Vitest | via pnpm | Test runner |
| `liquibase update` | Liquibase | `liquibase` | Needs JRE — `jdk21_headless` in devShell |
| `flutter build` | Flutter SDK | `flutter` | In nixpkgs |
| `flutter test` | Flutter test | `flutter` | In nixpkgs |
| `dart analyze` | Dart analyzer | via Flutter | Bundled with Flutter SDK |
| `tofu plan/apply` | OpenTofu | `opentofu` | In nixpkgs |
| `trivy fs` | Trivy | `trivy` | In nixpkgs |
| `semgrep` | Semgrep | `semgrep` | In nixpkgs |
| `gitleaks detect` | Gitleaks | `gitleaks` | In nixpkgs |
| `openscad` | OpenSCAD | `openscad-unstable` | Already in flake |
| `process-compose up` | process-compose | `process-compose` | In nixpkgs |
| `pg_isready` | Postgres client | `postgresql_16` | For health checks |

---

## Project Structure

```
kanix/
├── flake.nix                    # Root flake — composes all sub-flakes
├── flake.lock
├── .envrc                       # use flake
├── .env.example                 # All env vars with placeholders
├── .gitignore
├── CLAUDE.md                    # Dev instructions
├── README.md                    # Project overview + contributions model
├── TEST-METHODOLOGY.md          # Test methodology manifesto
├── RUNBOOK.md                   # Operations runbook
├── process-compose.yml          # Dev service orchestration
├── .specify/                    # Spec-kit metadata
├── specs/                       # Specifications
│   └── admin/
│       ├── spec.md
│       ├── plan.md
│       ├── tasks.md
│       ├── research.md
│       ├── data-model.md
│       ├── interview-notes.md
│       └── learnings.md
├── scad/                        # OpenSCAD models (existing)
│   ├── flake.nix                # Sub-flake for SCAD tooling
│   ├── lib/
│   └── *.scad
├── site/                        # Astro public site (existing, evolved)
│   ├── flake.nix                # Sub-flake for site
│   ├── astro.config.mjs
│   ├── package.json
│   └── src/
│       ├── pages/               # SSG pages + checkout islands
│       ├── components/          # Astro components + checkout JS
│       ├── layouts/
│       ├── data/
│       └── styles/
├── api/                         # Fastify backend (new)
│   ├── flake.nix                # Sub-flake for API
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts             # Entry point
│   │   ├── config.ts            # Single config module
│   │   ├── errors.ts            # Error hierarchy
│   │   ├── logger.ts            # Pino setup
│   │   ├── shutdown.ts          # Graceful shutdown
│   │   ├── plugins/             # Fastify plugins (auth, cors, rate-limit)
│   │   ├── routes/              # Route handlers by domain
│   │   │   ├── admin/           # Admin API routes
│   │   │   ├── customer/        # Customer API routes
│   │   │   └── public/          # Public API routes (catalog, checkout)
│   │   ├── domain/              # Business logic by domain
│   │   │   ├── orders/
│   │   │   ├── payments/
│   │   │   ├── inventory/
│   │   │   ├── fulfillment/
│   │   │   ├── shipping/
│   │   │   ├── support/
│   │   │   ├── disputes/
│   │   │   ├── evidence/
│   │   │   ├── catalog/
│   │   │   ├── cart/
│   │   │   ├── contributors/
│   │   │   └── notifications/
│   │   ├── adapters/            # External service adapters
│   │   │   ├── stripe.ts
│   │   │   ├── easypost.ts
│   │   │   ├── email.ts         # Stubbed
│   │   │   ├── storage.ts       # File storage
│   │   │   └── tax.ts           # Stripe Tax + stub
│   │   ├── db/                  # Drizzle schema + queries
│   │   │   ├── schema/          # Table definitions
│   │   │   └── queries/         # Typed queries
│   │   └── ws/                  # WebSocket handlers
│   ├── migrations/              # Liquibase changelogs
│   │   ├── changelog-master.xml
│   │   └── changesets/
│   ├── seeds/                   # Dev seed data
│   └── tests/
│       ├── unit/
│       ├── integration/
│       └── fixtures/
├── admin/                       # Flutter admin app (new)
│   ├── flake.nix                # Sub-flake
│   ├── pubspec.yaml
│   ├── lib/
│   │   ├── main.dart
│   │   ├── routes/
│   │   ├── providers/           # Riverpod providers
│   │   ├── models/
│   │   ├── services/
│   │   └── widgets/
│   └── test/
├── customer/                    # Flutter customer app (new)
│   ├── flake.nix                # Sub-flake
│   ├── pubspec.yaml
│   ├── lib/
│   │   ├── main.dart
│   │   ├── routes/
│   │   ├── providers/
│   │   ├── models/
│   │   ├── services/
│   │   └── widgets/
│   └── test/
└── deploy/                      # Infrastructure (new)
    ├── flake.nix                # Sub-flake for NixOS configs
    ├── tofu/                    # OpenTofu configurations
    │   ├── main.tf
    │   ├── variables.tf
    │   ├── dns.tf               # Cloudflare DNS
    │   ├── servers.tf
    │   └── outputs.tf
    ├── nixos/                   # NixOS server modules
    │   ├── api-server.nix
    │   ├── postgres.nix
    │   ├── nginx.nix
    │   ├── supertokens.nix
    │   └── common.nix
    └── tests/                   # Nix VM tests
        └── test-*.nix
```

---

## Phase Dependencies

```
Phase 1 (Repo Restructure + Nix) ──▶ Phase 2 (Test Infra + Foundation)
Phase 2 ──▶ Phase 3 (Database + Migrations)
Phase 3 ──▶ Phase 4 (Auth + Admin Identity)
Phase 4 ──▶ Phase 5 (Catalog + Inventory)
Phase 5 ──▶ Phase 6 (Cart + Checkout + Payments)
Phase 6 ──▶ Phase 7 (Fulfillment + Shipping)
Phase 7 ──▶ Phase 8 (Support + Disputes + Evidence)
Phase 8 ──▶ Phase 9 (Contributor/Royalty System)
Phase 9 ──▶ Phase 10 (Notifications + Real-time)

Phase 2 ──▶ Phase 11 (Flutter Admin App Shell) [parallel with 3-10]
Phase 2 ──▶ Phase 12 (Flutter Customer App Shell) [parallel with 3-10]
Phase 2 ──▶ Phase 13 (Astro Site Evolution) [parallel with 3-10]

Phase 10 + 11 + 12 + 13 ──▶ Phase 14 (Integration + E2E)
Phase 14 ──▶ Phase 15 (Infrastructure + Deploy)
Phase 15 ──▶ Phase 16 (Operations Runbook + Final Validation)
```

### Parallel Workstreams

**Stream A (Backend)**: Phase 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
**Stream B (Admin App)**: Phase 2 (wait) → 11 → connect to backend APIs as they land
**Stream C (Customer App)**: Phase 2 (wait) → 12 → connect to backend APIs as they land
**Stream D (Astro Site)**: Phase 2 (wait) → 13 → connect to backend APIs as they land

**Sync Points**:
- After Phase 2: all streams can begin
- After Phase 10: backend APIs complete, all frontend streams must connect
- Phase 14: all streams converge for integration testing
- Phase 15: integration tested code deploys to infrastructure

### Optimal Multi-Agent Strategy

```
Agent A: Phase 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 (backend)
Agent B: wait for Phase 2 → 11 (admin app shell + screens as APIs land)
Agent C: wait for Phase 2 → 12 (customer app shell + screens as APIs land)
Agent D: wait for Phase 2 → 13 (Astro site evolution + checkout)
All: → Phase 14 (integration) → 15 (infra) → 16 (runbook)
```

---

## Phase Breakdown

### Phase 1: Repo Restructure + Nix Flakes
[FR-098, FR-099]

Reorganize the existing repo into the hierarchical flake structure. Move existing files, create sub-flakes, set up direnv.

**Tasks**:
- Create root `flake.nix` composing all sub-flakes
- Move existing `scad/` files, create `scad/flake.nix` with OpenSCAD + BOSL2
- Update existing `site/` with its own `flake.nix`
- Create `api/flake.nix` with Node.js 22, pnpm, Liquibase + JRE, Postgres client
- Create `admin/flake.nix` and `customer/flake.nix` with Flutter SDK
- Create `deploy/flake.nix` with OpenTofu, Nginx
- Create `.envrc` with `use flake`
- Create `process-compose.yml` for dev services (Postgres, SuperTokens)
- Create `.env.example` with all env var placeholders
- Update `.gitignore` for all new directories
- Verify: `nix develop` enters shell with all tools, `nix flake check` passes

### Phase 2: Test Infrastructure + Foundational Backend
[FR-100, FR-103, FR-104, FR-105, FR-106, FR-107, FR-108, FR-109, FR-110, FR-111, FR-112, FR-113, FR-114]

Set up the API project skeleton with all foundational infrastructure.

**Tasks**:
- Initialize `api/` with pnpm, TypeScript strict, Vitest, ESLint + Prettier
- Implement `api/src/config.ts` — single config module, three-layer precedence, fail-fast validation
- Implement `api/src/errors.ts` — typed error hierarchy (AppError → ValidationError, NotFoundError, etc.)
- Implement `api/src/logger.ts` — Pino setup with structured JSON, correlation IDs
- Implement `api/src/shutdown.ts` — graceful shutdown with 30s timeout, ordered cleanup
- Implement Fastify server skeleton with health endpoints (`/health`, `/ready`)
- Implement security middleware: CORS (restrictive), rate limiting, security headers
- Implement JSON schema validation plugin for request bodies
- Implement global error handler (catches at boundary, logs with correlation ID, returns sanitized response)
- Set up Vitest with custom reporter for structured test output
- Set up CI workflow: lint, typecheck, test, security scan (Trivy, Semgrep, Gitleaks, npm audit)
- Create `api/package.json` scripts: dev, test, test:unit, test:integration, lint, lint:fix, typecheck, build, check
- Create `CLAUDE.md` development section
- Smoke test: server boots, `/health` returns 200, `/ready` returns 503 (no DB yet)

### Phase 3: Database + Migrations
[FR-032, FR-033, FR-101]

Set up Postgres, Liquibase migrations, and Drizzle ORM.

**Tasks**:
- Configure Postgres in `process-compose.yml` (dev) and `deploy/nixos/postgres.nix` (prod)
- Set up Liquibase with `changelog-master.xml` and `changesets/` directory
- Create initial migration: all core tables from data-model.md (customer, product, product_variant, product_class, product_media, collection, inventory_*, order, order_line, payment, etc.)
- Create CHECK constraints: `available >= 0`, `reserved >= 0`, `on_hand >= 0`, `price_minor > 0`
- Create unique constraints: `(variant_id, location_id)` on inventory_balance, `order_number`, `sku`, `slug`
- Create foreign key constraints with RESTRICT (not CASCADE) for financial data
- Set up Drizzle ORM with schema introspection from Postgres
- Create seed script with dev data (products, variants, inventory, admin user)
- Add `db:migrate`, `db:seed`, `db:reset` scripts
- Integration test: migrations run, seed data loads, Drizzle queries work, constraints enforce
- Update `/ready` to check Postgres connectivity

### Phase 4: Auth + Admin Identity
[FR-064, FR-065, FR-066, FR-068, FR-077, FR-078, FR-079, FR-080]

Set up SuperTokens for customer auth, admin auth, and GitHub OAuth.

**Tasks**:
- Configure SuperTokens core in `process-compose.yml` (dev) and `deploy/nixos/supertokens.nix` (prod)
- Implement customer auth recipe: email/password with email verification
- Implement admin auth recipe: separate from customer, email/password
- Implement GitHub OAuth: "Link GitHub Account" flow for contributors
- Implement capability-based permission system: roles → capabilities, middleware to check capabilities per endpoint
- Implement `admin_audit_log` middleware: auto-log privileged actions with actor, before/after, IP
- Create admin seed data: default admin user, roles (support, fulfillment, finance, super_admin), permissions
- Integration tests: customer signup + login + email verification, admin login + permission check, GitHub OAuth link, audit log creation
- Update `/ready` to check SuperTokens connectivity

### Phase 5: Catalog + Inventory
[FR-001 through FR-006, FR-032 through FR-038]

Product catalog, variants, classifications, and inventory management.

**Tasks**:
- Implement product CRUD API (admin): create, read, update, status transitions (draft → active → archived)
- Implement product variant CRUD API (admin): material variants (TPU/PA11/TPC), pricing, SKU
- Implement product classification system: product_class, product_class_membership
- Implement product media API: upload, reorder, alt text
- Implement collection API: CRUD, product-collection associations
- Implement inventory balance API: view balances, low-stock detection
- Implement inventory adjustment API: restock, shrinkage, damage — with audit logging
- Implement inventory reservation system: atomic reserve/release/consume/expire with DB-level locking
- Implement reservation cleanup cron: expire reservations past TTL
- Implement low-stock alerts: detect when `available < safety_stock`, queue notification
- Implement public catalog API: product listing, variant details, availability check (no auth required)
- Implement customer address CRUD API (create, update, delete, set default, US-only validation)
- Integration tests: product lifecycle, variant pricing, inventory atomicity (concurrent reservations), low-stock detection, reservation expiry

### Phase 6: Cart + Checkout + Payments
[FR-007 through FR-018, FR-019 through FR-031, FR-117 through FR-120]

Cart, kit composition, checkout flow, Stripe payments, and tax calculation.

**Tasks**:
- Implement cart API: create (guest via token, authenticated via customer_id), add/remove items, validate inventory
- Implement kit composition: kit_definition, kit_class_requirement, cart_kit_selection — validate class requirements, calculate kit price
- Implement checkout flow: validate cart → create inventory reservations → calculate shipping (EasyPost rates) → calculate tax (Stripe Tax) → create Stripe PaymentIntent → create order with snapshots
- Implement order creation: four orthogonal state machines, order_number generation (KNX-000001), address/product/price snapshots
- Implement Stripe webhook handler: signature validation, idempotent processing for payment_intent.succeeded, payment_intent.payment_failed, charge.refunded
- Implement refund API (admin): full and partial refunds, reason codes, actor attribution
- Implement order cancellation API (admin): release reservations, initiate refund if paid
- Implement Stripe Tax adapter: production mode with Stripe Tax API, stub mode (zero tax) when STRIPE_TAX_ENABLED=false
- Implement policy acknowledgment: capture which policy version customer saw at checkout
- Implement kit cart re-validation on definition change (FR-E005)
- Implement reservation expiry / payment race handler (FR-E008)
- Implement idempotent inventory adjustments with idempotency keys (FR-E009)
- Implement Stripe unreachable checkout error handling (FR-E012)
- Implement duplicate email verification conflict detection (FR-E017)
- Integration tests: guest checkout end-to-end, kit composition validation, payment success/failure webhooks, refund flow, tax calculation, order snapshot immutability, idempotent webhooks, edge cases

### Phase 7: Fulfillment + Shipping
[FR-039 through FR-049]

Fulfillment task management and EasyPost shipping integration.

**Tasks**:
- Implement fulfillment task API: auto-create on order confirmation, state machine (new → assigned → picking → picked → packing → packed → shipment_pending → done)
- Implement task assignment API: assign to admin user
- Implement shipment API: create draft, add packages, add lines (order_line mapping)
- Implement EasyPost adapter: rate quotes, label purchase, tracking webhook processing
- Implement label purchase flow: request rates → select service → buy label → record cost
- Implement tracking webhook handler: update shipment status, create shipment_event records
- Implement shipping status propagation: shipment status → order shipping_status
- Implement fulfillment status propagation: all lines fulfilled → order fulfillment_status = fulfilled
- Implement shipment void-label, refresh-tracking, mark-shipped, resend-confirmation APIs
- Integration tests: fulfillment task lifecycle, shipment creation, label purchase (EasyPost test mode), tracking event processing, status propagation, void/refresh operations

### Phase 8: Support + Disputes + Evidence
[FR-050 through FR-063]

Support tickets, dispute management, and evidence chain.

**Tasks**:
- Implement support ticket API: create (customer + admin), state machine, message threading, internal notes
- Implement ticket attachment upload: file validation (JPEG/PNG/PDF, 10MB max), storage adapter
- Implement warranty claim flow: validate warranty period (1 year from delivery), create ticket with category `warranty_claim`
- Implement dispute auto-creation: Stripe `charge.dispute.created` webhook → dispute record + payment_status → `disputed`
- Implement dispute state machine: opened → evidence_gathering → ready_to_submit → submitted → won/lost/accepted → closed
- Implement evidence auto-collection: shipment events → evidence_record, support messages → evidence_record, payment events → evidence_record, policy acknowledgments → evidence_record
- Implement evidence immutability: DB-level restriction (no UPDATE/DELETE on evidence_record)
- Implement evidence bundle generation: compile all evidence for a dispute, generate downloadable package
- Implement dispute readiness summary: check evidence completeness (tracking, delivery proof, policy, customer comms)
- Implement policy snapshot system: versioned copies of policies, linked to orders at checkout
- Implement manual evidence attachment API and evidence browsing API
- Implement fulfillment edge cases (blocked state, auto-return on cancel after picking)
- Implement shipping edge cases (label failure, delivery exception alerts, void cost credit)
- Implement duplicate ticket detection and merge flagging
- Integration tests: ticket lifecycle, warranty validation, dispute creation from webhook, evidence auto-collection, bundle generation, evidence immutability, edge cases

### Phase 9: Contributor / Royalty System
[FR-069 through FR-076]

Contributor registry, royalty tracking, milestone management.

**Tasks**:
- Implement contributor registry API: CRUD, linked to GitHub username
- Implement contributor_design API: link contributors to products they designed
- Implement per-design sales tracking: on order completion, increment contributor's design sales count
- Implement royalty calculation engine: 10% at 25-unit threshold, retroactive to unit 1
- Implement 501(c)(3) donation option: 2x rate (20%), charity tracking
- Implement royalty clawback: on refund, deduct from contributor accrual
- Implement milestone tracking: accepted PR reward, 25-unit royalty activation, 50-unit starter kit
- Implement tax document collection: W-9/W-8BEN upload, storage, approval workflow
- Implement contributor dashboard API: designs, sales, royalties, milestones, payouts
- Integration tests: royalty calculation at threshold, retroactive calculation, refund clawback, donation routing, milestone progression

### Phase 10: Notifications + Real-Time
[FR-081 through FR-087]

WebSocket real-time updates and notification system.

**Tasks**:
- Implement WebSocket server: @fastify/websocket, authenticated connections (admin/customer/guest tokens)
- Implement pub/sub system: subscribe to entity events, publish on state changes
- Implement message buffering: server-side buffer for disconnected clients (5 min), sequence IDs for replay
- Implement admin real-time: new orders, fulfillment changes, ticket updates, inventory alerts, dispute notifications
- Implement customer real-time: order status changes, shipping tracking, support replies
- Implement notification service: abstract notification dispatch (email, push, in-app)
- Implement email adapter: stubbed (log to file), interface ready for Postmark/SendGrid/SES
- Implement push notification adapter: stubbed, interface ready for FCM/APNs
- Implement admin alert preferences: per-admin configuration (push, email, both)
- Implement admin dashboard summary + alerts API
- Implement admin customer detail APIs (profile, orders, tickets)
- Implement admin settings APIs (shipping config)
- Integration tests: WebSocket connection + auth, pub/sub message delivery, reconnection + replay, notification dispatch, dashboard summary accuracy

### Phase 11: Flutter Admin App Shell
[Admin route map from architecture spec]

**Tasks**:
- Initialize Flutter project with Riverpod, Dio, GoRouter
- Implement auth flow: admin login, session management, permission-aware UI
- Implement app shell: navigation, dashboard, role-based menu visibility
- Implement dashboard: operational counts, alerts, quick links
- Build screens progressively as backend APIs land (orders, fulfillment, inventory, products, support, disputes, customers, settings)
- Implement real-time: WebSocket provider, live updates across screens
- Widget tests for each screen

### Phase 12: Flutter Customer App Shell
[Customer app requirements]

**Tasks**:
- Initialize Flutter project with Riverpod, Dio, GoRouter
- Implement auth flow: signup, login, email verification, GitHub OAuth link
- Implement catalog: product browsing, variant selection, kit builder
- Implement cart + checkout: authenticated checkout flow
- Implement order history: list, detail, real-time status
- Implement support: create ticket, message thread, attachments
- Implement warranty claims: select order, describe defect, upload photos
- Implement contributor dashboard: designs, sales, royalties, milestones
- Implement account settings: addresses, GitHub link, notification preferences
- Widget tests for each screen

### Phase 13: Astro Site Evolution
[FR-088 through FR-092]

**Tasks**:
- Evolve existing Astro site with product catalog pages (SSG)
- Implement product detail pages with material variants, pricing, warranty info
- Implement guest checkout flow as Astro islands (client-side JS hitting API)
- Implement cart UI (client-side, cart token in localStorage)
- Implement checkout UI: email, address, shipping selection, tax display, Stripe Elements payment
- Add contributions model page
- Add warranty and returns policy page with material-specific disclaimers
- Add care instructions page per material tier
- Update README with contributions model

### Phase 14: Integration + E2E
[SC-001 through SC-018]

**Tasks**:
- End-to-end guest checkout: Astro site → API → Stripe → order confirmation
- End-to-end authenticated checkout: Flutter app → API → Stripe → order tracking
- End-to-end kit purchase: kit builder → checkout → inventory reservation per component
- End-to-end fulfillment: order → task → pick → pack → ship → deliver → evidence
- End-to-end dispute: delivered order → chargeback webhook → evidence bundle
- End-to-end contributor: CLA → link GitHub → design sales → royalty threshold → dashboard
- Concurrent inventory test: multiple simultaneous checkouts for limited stock
- WebSocket integration: real-time updates across admin and customer clients
- Security: auth boundary tests, permission matrix validation, injection testing
- Performance: checkout flow under load, WebSocket message latency
- Create/verify UI_FLOW.md for admin and customer apps

### Phase 15: Infrastructure + Deploy
[FR-093 through FR-097]

**Tasks**:
- Write OpenTofu configurations: server provisioning, Cloudflare DNS, networking
- Write NixOS modules: api-server, postgres, nginx (Let's Encrypt), supertokens
- Write Nix VM tests: service binding, firewall rules, TLS configuration (per TEST-METHODOLOGY.md)
- Configure CI/CD: build → test → deploy pipeline
- Configure Nginx reverse proxy: API, Astro site, WebSocket upgrade
- Configure production environment: secrets management, log aggregation, backup schedule

### Phase 16: Operations Runbook + Final Validation
[FR-102]

**Tasks**:
- Write RUNBOOK.md with all maintenance tasks, cadences, and failure recovery
- Final security scan and vulnerability review
- Final E2E validation of all user flows
- Documentation review: README, CLAUDE.md, API docs

---

## Testing Strategy

### Test Runner + Reporter
- **Backend**: Vitest with custom JSON reporter for structured output to `test-logs/`
- **Flutter**: `flutter test` with `--machine` flag for structured output
- **Nix**: `nix build .#checks.x86_64-linux.<test>` for VM tests

### Test Tiers

| Tier | What | Runner | When |
|------|------|--------|------|
| Unit | Pure business logic, state machines, utilities | Vitest / flutter test | Every commit |
| Integration | API endpoints against real Postgres + Stripe test mode | Vitest | Every commit |
| Contract | JSON schema validation between API ↔ Flutter clients | Vitest + flutter test | Every commit |
| E2E | Full user flows across all clients | Playwright (Astro) + flutter integration test | PR + nightly |
| Security | Trivy, Semgrep, Gitleaks, npm audit | CI scanners | Every commit |
| Infrastructure | Nix VM tests (service binding, firewall, TLS) | nix build | On deploy/ changes |

### Test Plan Matrix

| SC | Test Tier | Fixture Requirements | Assertion | Infrastructure |
|----|-----------|---------------------|-----------|----------------|
| SC-001 | E2E (user-flow) | Seeded product with inventory, Stripe test key | Guest checkout completes in <3 min | Postgres, Stripe test, API server |
| SC-002 | Unit + Integration | State machine definitions | Every invalid transition returns error | None (unit), Postgres (integration) |
| SC-003 | Integration (concurrency) | 1 unit available, 2 concurrent clients | Exactly 1 reservation succeeds | Postgres with advisory locks |
| SC-004 | Integration | 3 guest orders + account creation | Orders appear <1s after email verification | Postgres, SuperTokens |
| SC-005 | Integration (user-flow) | Complete order lifecycle with all evidence types | Bundle contains all evidence types | Postgres, Stripe test, EasyPost test |
| SC-006 | Integration | Admin performs refund, adjustment, role change | Audit log entries with before/after | Postgres, SuperTokens |
| SC-007 | Integration | WebSocket client + state change trigger | Message received within 2s | Postgres, WebSocket server |
| SC-008 | Scan | Full codebase | Zero critical findings | Trivy, Semgrep, Gitleaks |
| SC-009 | Manual + CI | Fresh clone | `nix develop && pnpm dev` works | Nix |
| SC-010 | Integration | Kit definition + incomplete selections | Checkout rejected with clear error | Postgres |
| SC-011 | Unit + Integration | Contributor with 30 sales, 1 refund | Royalty = 10% * (30-1) * unit_price | Postgres |
| SC-012 | Integration | Running server | /health 200, /ready 503→200→503 | Postgres, SuperTokens |
| SC-013 | Infrastructure | Fresh tofu state | `tofu plan` shows create-only | OpenTofu |
| SC-014 | Integration | Same Stripe event sent twice | Second processing is no-op | Postgres, Stripe test |
| SC-015 | Integration | Invalid request bodies per endpoint | Correct 4xx status + error code | Postgres |
| SC-016 | Integration | Upload file, request from unauthorized user | 403 on unauthorized access | Postgres, storage |
| SC-017 | Integration | Orders to TX (8.25%), OR (0%), NY (8.875%) | Tax amounts match expected | Stripe Tax test mode |
| SC-018 | Integration | Order delivered 11 months ago vs 13 months ago | Claim accepted vs rejected | Postgres |

### Pre-PR Gate

```bash
# Makefile target
pre-pr: lint typecheck test test:integration security
```

Runs: ESLint + Prettier → TypeScript strict → Vitest unit → Vitest integration → Trivy + Semgrep + Gitleaks + npm audit

### Fix-Validate Loop

Every implementation phase follows the TDD cycle:
1. Write failing tests for the phase's FRs
2. Implement until tests pass
3. Run full test suite (regression)
4. Run security scan
5. If anything fails → fix → re-run from step 3

---

## Interface Contracts (Internal)

| IC | Name | Producer | Consumer(s) | Specification |
|----|------|----------|-------------|---------------|
| IC-001 | Database schema | Phase 3 (T025, T026) | All API code (Drizzle) | Postgres tables per data-model.md, Drizzle schema introspected from DB. Includes `order.email` for guest linking and `cart.token` for guest cart lookup. |
| IC-002 | Auth session tokens | Phase 4 (T032, T033) | All API routes, WebSocket auth, Flutter clients | SuperTokens session format, access token in `Authorization: Bearer <token>` header, refresh via SuperTokens SDK |
| IC-003 | Admin permissions | Phase 4 | All admin route handlers | Capability strings (e.g., `orders.read`, `inventory.adjust`), checked via `requireCapability()` middleware |
| IC-004 | Stripe PaymentIntent | Phase 6 (checkout) | Phase 6 (webhooks), Phase 8 (disputes) | PaymentIntent ID stored on order, metadata includes order_id, webhook events reference PI ID |
| IC-005 | Inventory reservation | Phase 5 (inventory) | Phase 6 (checkout), Phase 7 (fulfillment) | Reservation ID, variant_id, quantity, status, expires_at. Reserve via `inventoryService.reserve()`, consume via `inventoryService.consume()` |
| IC-006 | EasyPost shipment | Phase 7 (shipping) | Phase 8 (evidence), Phase 10 (notifications) | EasyPost tracker ID, webhook events with status/description/occurred_at, stored as shipment_event |
| IC-007 | Evidence records | Phase 8 (evidence) | Phase 8 (disputes, bundles) | evidence_record with type, storage_key, text_content, metadata_json. Immutable. Types: `delivery_proof`, `tracking_history`, `customer_communication`, `policy_acceptance`, `payment_receipt` |
| IC-008 | WebSocket messages | Phase 10 | Flutter admin app, Flutter customer app, Astro checkout | JSON messages: `{type: string, entity: string, entityId: string, data: object, sequenceId: number}` |
| IC-009 | Public catalog API | Phase 5 | Astro site (SSG + islands), Flutter customer app | `GET /api/products`, `GET /api/products/:id` — response shape per API contract in spec section 4 |
| IC-010 | Cart token | Phase 6 | Astro site (localStorage), API (cookie/header) | Opaque UUID, passed as `X-Cart-Token` header or `cart_token` cookie |

---

## Critical Path (User Perspective)

### Day-1 User Flow
Customer lands on Astro site → browses products → selects variant → adds to cart → enters email + address → pays → gets confirmation → order ships next day.

### Phase Mapping
1. **Phase 1-2**: Dev environment works (developer day-1)
2. **Phase 3**: Database exists with products
3. **Phase 5**: Products browsable via API
4. **Phase 6**: Cart + checkout + payment works → **first testable user result**
5. **Phase 7**: Fulfillment + shipping works → orders can ship
6. **Phase 13**: Astro site has product pages + checkout UI → **first user-facing result**

### Incremental Integration Checkpoints
- Phase 2 done: API server boots, `/health` returns 200
- Phase 3 done: Postgres connected, seed data loaded, Drizzle queries work
- Phase 4 done: Customer can sign up, admin can log in, permissions enforced
- Phase 5 done: Products browsable, inventory tracked, reservations atomic
- Phase 6 done: **Full checkout works** — cart → reserve → pay → order created
- Phase 7 done: **Full commerce loop** — checkout → fulfill → ship → deliver
- Phase 13 done: **Full user experience** — Astro site with checkout, customer can buy

---

## Complexity Tracking

| Decision | Constitution Principle | Justification |
|----------|----------------------|---------------|
| Four orthogonal order state machines | V (State Machine Correctness) | Required by constitution — avoids impossible hybrid states |
| Kit composition system | IX (Simplicity) | Adds complexity beyond simple product variants, but required by business model — kits are the primary product offering |
| Contributor royalty engine | IX (Simplicity) | Non-trivial subsystem (retroactive calculation, clawback, donation routing), but user explicitly included in scope — core differentiator for open-source ecosystem |
| Hierarchical Nix flakes | I (Nix-First) | More complex than a single flake, but required by constitution — each concern gets its own flake for independent builds |
| Stripe Tax integration | IX (Simplicity) | Could stub permanently, but user explicitly required first-class tax calculation for compliance |
