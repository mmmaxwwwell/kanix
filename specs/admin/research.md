# Research — Kanix Commerce Platform

## Technology Decisions

### Backend Framework: Fastify + TypeScript
**Decision**: Fastify with TypeScript in strict mode.
**Rationale**: User's explicit choice. Fastify has native Pino integration (logging), built-in JSON schema validation (input validation at boundary), plugin architecture for clean separation of concerns, and WebSocket support via @fastify/websocket. TypeScript strict mode catches type errors at compile time.
**Alternatives rejected**:
- Express: Slower, no built-in schema validation, middleware-heavy architecture adds complexity without benefit. User didn't request it.
- Hono/Elysia: Newer, less battle-tested for production ecommerce with payment processing.
- NestJS: Too much abstraction, decorator-heavy, violates Constitution IX (Simplicity).

### ORM/Query Layer: Drizzle ORM
**Decision**: Drizzle ORM for type-safe Postgres queries.
**Rationale**: SQL-first philosophy matches Liquibase (both treat SQL as the source of truth). Type-safe queries without hiding SQL. Supports raw SQL escape hatch when needed. Good Postgres support including transactions, advisory locks (needed for inventory atomicity).
**Alternatives rejected**:
- Prisma: Has its own migration system that conflicts with Liquibase. Schema-first approach where Prisma owns the schema definition — doesn't work when Liquibase owns migrations.
- Kysely: Query builder only, no schema inference from DB. Would need manual type definitions for every table.
- Raw pg client: No type safety. Every query is a string with runtime type errors.
**User decision**: Delegated to agent.

### Database Migrations: Liquibase
**Decision**: Liquibase with SQL-first changelogs.
**Rationale**: User's explicit choice. SQL-first means migrations are plain SQL files, easy to review, support rollback. Liquibase tracks applied changesets in a `databasechangelog` table.
**Alternatives rejected**:
- Knex migrations: User explicitly chose Liquibase over Knex/Prisma.
- Prisma Migrate: User explicitly chose Liquibase.
- golang-migrate: Wrong ecosystem (Go, not Node.js).
**User decision**: User chose explicitly.

### Package Manager: pnpm
**Decision**: pnpm for the API and site workspaces.
**Rationale**: Fast installs via content-addressable store, strict dependency resolution (no phantom deps), great monorepo workspace support, `--ignore-scripts` support for supply chain safety.
**Alternatives rejected**:
- npm: Slower installs, flat node_modules allows phantom dependencies.
- yarn: Similar to pnpm but Berry (v4) has compatibility issues with some packages.
**User decision**: Delegated to agent.

### WebSocket Library: @fastify/websocket
**Decision**: @fastify/websocket (ws under the hood) for real-time transport.
**Rationale**: Native Fastify integration means WebSocket routes use the same auth middleware, decorators, and hooks as HTTP routes. No separate server needed.
**Alternatives rejected**:
- Socket.IO: Adds its own protocol layer, unnecessary for simple pub/sub. Heavier dependency.
- Raw ws: Works but loses Fastify integration (auth, decorators, hooks).
**User decision**: Delegated to agent.

### Flutter State Management: Riverpod
**Decision**: Riverpod for Flutter state management (admin + customer apps).
**Rationale**: Production-grade, compile-time safe, testable without widget tree. Supports async state (API calls), caching, and dependency injection. Used by many production Flutter apps.
**Alternatives rejected**:
- BLoC: More boilerplate, stream-based API is verbose for simple state.
- Provider: Riverpod is the successor by the same author, with better type safety and testing.
- GetX: Poor testability, implicit global state, community concerns about maintenance.
**User decision**: Delegated to agent.

### Flutter HTTP Client: Dio
**Decision**: Dio for HTTP requests in Flutter apps.
**Rationale**: Interceptors for auth token injection, request/response logging, retry logic. Supports request cancellation, form data, file uploads. Well-maintained.
**Alternatives rejected**:
- http package: Too basic — no interceptors, no retry, manual auth header management.
- Chopper: Code generation adds build complexity without proportional benefit.
**User decision**: Delegated to agent.

### Shipping Provider: EasyPost
**Decision**: EasyPost behind an adapter interface.
**Rationale**: Best API quality among shipping providers. Official Node SDK with TypeScript types. Uniform carrier abstraction across 100+ carriers. Pay-per-label pricing (no monthly minimums). Webhooks for real-time tracking.
**Alternatives rejected**:
- Stamps.com: USPS-only, old API, no modern SDK — user originally suggested but doesn't meet multi-carrier needs.
- ShipStation: UI-focused fulfillment tool, not API-first.
- Shippo: Close second but EasyPost has broader carrier support and better API polish.
- ShipEngine: Viable but EasyPost's ecosystem is larger.
**User decision**: User accepted recommendation.

### Tax Calculation: Stripe Tax
**Decision**: Stripe Tax as production implementation, stub adapter for dev without API key.
**Rationale**: Already using Stripe for payments — Stripe Tax integrates natively with PaymentIntents. Handles nexus determination, rate calculation, and compliance reporting. Gated on STRIPE_TAX_ENABLED config + valid API key.
**Alternatives rejected**:
- TaxJar: Separate service, additional API integration, additional cost. Stripe Tax is simpler since we're already on Stripe.
- Avalara: Enterprise-focused, more complex than needed for a startup.
- Manual rate table: Not compliant — US sales tax is extremely complex (10,000+ jurisdictions).
**User decision**: User explicitly required first-class tax calculation, not a permanent stub.

### Infrastructure: OpenTofu + Cloudflare + Let's Encrypt
**Decision**: OpenTofu for IaC, Cloudflare for DNS, Let's Encrypt for TLS via Nginx.
**Rationale**: User's explicit choices. OpenTofu is the open-source Terraform fork (no license concerns). Cloudflare provides DNS management, CDN, and DDoS protection. Let's Encrypt provides free, automated TLS certificates.
**Alternatives rejected**:
- Terraform: BSL license concerns. User explicitly chose OpenTofu.
- Route53: AWS-specific, user chose Cloudflare.
- Paid TLS certs: Unnecessary when Let's Encrypt is free and automated.
**User decision**: User chose explicitly.

### File Storage: S3-compatible with local filesystem adapter
**Decision**: Abstracted storage adapter. Local filesystem for dev, S3-compatible (MinIO or AWS S3) for production.
**Rationale**: Ticket attachments, tax documents, evidence files need persistent storage. S3 API is the de facto standard. Local filesystem for dev avoids cloud dependency during development.
**Alternatives rejected**:
- Database BLOBs: Poor performance for large files, complicates backups.
- Cloud-only storage: Requires cloud credentials for local dev.
**User decision**: Delegated to agent.

## Constraint Reasoning

### Why Liquibase + Drizzle (not Prisma)
The user explicitly chose Liquibase for migrations. Prisma owns the schema definition and generates migrations from it — this conflicts with Liquibase owning the migration lifecycle. Drizzle can introspect an existing database schema, so it works alongside Liquibase: Liquibase creates/migrates the schema, Drizzle reads it for type-safe queries. This is the only ORM combination that respects the user's migration choice.

### Why single inventory location for v1
Manufacturing is outsourced and ships from one location. Multi-location adds complexity without business value at launch. The schema supports multi-location (inventory_balance has location_id), but the UI and business logic default to the single location. This can be expanded later without schema changes.

### Why WebSocket over SSE
The admin app needs bidirectional communication (admin actions trigger state changes that other admins see). SSE is server→client only. WebSocket supports both directions with a single connection. The premium experience commitment also favors the lower-latency option.

### Why Stripe Tax over a stub
User explicitly required tax calculation as a first-class citizen. US sales tax has 10,000+ jurisdictions with varying rates, nexus rules, and product taxability categories. A manual rate table would be non-compliant. Stripe Tax integrates natively with the existing Stripe PaymentIntent flow.

## User Preferences and Pushbacks

- **Liquibase is non-negotiable** — user explicitly chose it over Knex/Prisma
- **OpenTofu is non-negotiable** — user explicitly chose it over Terraform
- **EasyPost is accepted** — user was flexible on shipping provider, accepted recommendation
- **No colors** — everything is black, variant axis is material only
- **No custom orders** — standard catalog only for v1
- **US only** — no international shipping
- **Email stubbed** — email delivery is stubbed for v1, implement real provider later
- **Tax is first-class** — not a permanent stub, must use Stripe Tax with dev fallback
- **Premium experience** — next-day shipping, real-time updates, first-class support
- **Nix-first** — all tooling through Nix flakes, hierarchical flake system
- **Operations runbook required** — maintenance tasks with cadence, failure recovery procedures
