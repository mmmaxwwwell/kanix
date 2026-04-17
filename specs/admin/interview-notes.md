# Interview Notes — Kanix Commerce Platform

**Preset**: enterprise
**Nix available**: yes
**Date**: 2026-04-16

## Project Overview

Kanix is a business building a modular dog handler belt system. Currently in prototyping phase for both software and mechanical design. The commerce platform is being built to sell Kanix-manufactured products directly — not the third-party products (flashlights, pepper spray, etc.) that the holsters are designed for.

## Key Decisions

### Scope
- **Full platform build**: customer app (Flutter), admin app (Flutter), public site (Astro), backend API (Fastify+TS), Postgres, Stripe, SuperTokens, infrastructure
- Customer app: Flutter web, iOS, Android — full experience: catalog browsing, purchasing, order tracking, support, warranty claims
- Admin app: Flutter web (+ mobile?) — internal operations
- Public site: Astro — unauthenticated entry point with full guest checkout flow (no login required to buy), plus marketing/SEO pages
- Flutter app ALSO supports catalog browsing and purchasing (authenticated)
- Two purchase paths: guest checkout (Astro) and authenticated checkout (Flutter app)
- NOT selling third-party products — only Kanix-manufactured products

### Infrastructure
- **IaC**: OpenTofu (not Terraform) for all infrastructure provisioning
- **DNS**: Cloudflare
- **TLS**: Let's Encrypt via Nginx
- **Database migrations**: Liquibase (not Knex/Prisma — explicit user choice)
- **Nix**: Hierarchical flake system, NixOS for servers, Nix VM tests for infrastructure
- **CI/CD**: GitHub Actions (existing)

### Rejected Alternatives
- Knex/Prisma for migrations → user chose Liquibase (Java-ecosystem migration tool, SQL-first, supports rollback)
- Terraform → user chose OpenTofu (open-source fork, same HCL syntax, no license concerns)

### Repo Reorganization
- OpenSCAD models get their own flake
- Site keeps its own flake
- New directories: api/, admin/, customer/, deploy/
- Root flake composes all sub-flakes

### Business Context
- Currently prototyping phase — no manufacturing yet
- Holsters designed for third-party products (flashlights, pepper spray, treat bags, etc.)
- Those third-party products will never be sold/manufactured by Kanix
- Kanix will manufacture and sell its own products (belt modules, plates, etc.)
- Premium product positioning — next-day shipping always
- Outsourced manufacturing, batch production model
- Never oversell — inventory correctness is critical

### Products & Variants
- Product variants by material: FDM TPU (cheaper) and SLS PA11 (more expensive)
- Starter kits: configurable bundles
  - 4 modules + 4 plates + belt
  - 3 modules + 3 plates + belt
  - User picks which modules are in the kit
- Kit is a configurable bundle, not a fixed SKU — user selects components

### Checkout & Auth
- Guest checkout on Astro: email + shipping address + Stripe payment, no account required
- Flutter app also supports catalog browsing and authenticated checkout
- Account creation (Flutter app) needed for: order tracking, support tickets, warranty claims
- Account linked by email — guest orders can be "claimed" when user creates account later

### Auth Landscape
1. **Customer auth (SuperTokens)**: email/password for Flutter app (catalog, checkout, order tracking, support, warranty)
2. **GitHub OAuth (SuperTokens)**: "Sign in with GitHub" links a GitHub identity to an existing account. Used by contributors to link their GitHub user to their contributor record (created by CLA bot at first PR). This enables the system to track royalties by knowing which GitHub user = which contributor = which designs they contributed.
3. **Admin auth (SuperTokens)**: internal operators, capability-based permissions, separate from customer auth
- Not a separate portal — just a "Link GitHub Account" button in the Flutter app account settings
- Contributors who are also customers have one account with linked GitHub identity

### Real-time & Notifications
- Real-time push updates required (premium experience) — WebSocket or SSE for admin app (live order feed, fulfillment queue, support tickets, inventory alerts) and customer app (order status updates, support replies)
- Email notifications: order confirmation, shipping + tracking, support ticket replies, admin alerts (low stock, new dispute, delivery exception)
- Email provider: abstracted behind an adapter interface, stubbed for v1 (log-to-console or file), implement real provider later (Postmark, SendGrid, SES — TBD)
- In-app push notifications for mobile (Flutter app) — TBD provider, but design the notification system to support it

### Shipping
- Provider: EasyPost (with adapter abstraction for future provider swap)
- Multi-carrier: USPS, UPS, FedEx via EasyPost uniform API
- Real-time tracking via EasyPost webhooks
- Shipping evidence auto-captured for chargeback defense
- Next-day shipping commitment — fulfillment SLA is critical

### Contributions Model — IN SCOPE for initial build
- Open-source contributor incentive program
- Milestones: Accepted PR → 2 plates + 2 modules (~$20-25 cost); 25 units sold → 10% retroactive royalty (or 2x donation to 501(c)(3)); 50 units sold → full starter kit
- CLA bot on GitHub records contributor agreement at first PR
- Royalty agreement + tax forms (W-9/W-8BEN) collected before first payment at 25-unit threshold
- Backend needs: contributor registry (linked to GitHub user), per-design sales tracking, royalty calculation engine, payout/donation management, W-9/W-8BEN document collection
- Display: contributions model in GitHub README + Astro site

### Custom Orders
- Not doing custom orders right now — all products are standard catalog
- "Custom orders final sale" clause in warranty is forward-looking, keep in policy text but no custom order flow needed in v1

### Warranty & Returns
- 30-day return policy: unused, original condition, buyer pays return shipping (unless defective/wrong item), custom orders final sale
- 1-year limited warranty against manufacturing defects under normal use
- Covered: layer delamination, cracking, dimensional defects, hardware failure
- Not covered: misuse, normal wear, dog damage, chemical exposure, loss/theft, heat deformation of TPU
- Heat exclusion: TPU softens >60°C/140°F (car interiors), disclosed on product page + warranty page + care instructions. TPC kits rated to 130°C/266°F recommended for hot-vehicle use
- Safety disclaimer: accessories not safety equipment, 3D-printed parts can fail, inspect before use, liability limited to purchase price
- Display: warranty info on Astro site + Flutter app

### Material Tiers
- FDM TPU: cheaper, standard option, heat-sensitive (softens >60°C)
- SLS PA11: more expensive, premium option
- TPC: heat-resistant option (130°C), recommended for hot-vehicle use
- Material choice affects warranty coverage (TPU heat deformation not covered)
- Material limitations disclosed on product page, warranty page, care instructions

### Colors & Customization
- No color choices — everything is black
- No custom orders in v1
- Variant axis is material only (TPU / PA11 / TPC)

### Kit / Bundle System
- Products are classified into categories (e.g., class A = plates, class B = modules, class C = belts)
- Kits are defined as "N of class A + M of class B + P of class C" — user picks which specific products from each class
- Kit purchase requires ALL class requirements to be satisfied (can't buy partial kit)
- If any selected item is out of stock, the kit cannot be purchased — user must pick a different item from that class
- Kit pricing is a bundle discount vs buying individually

### Account & Order Linking
- Guest checkout: email only, no account required
- Email verification required to create an account (SuperTokens email verification)
- Once account is created with verified email, ALL previous guest orders placed with that email automatically appear in order history
- Account required for: warranty claims, support tickets, order tracking, contributor royalty dashboard
- No "claiming" flow needed — just email match on verified account

### Non-Goals (v1)
- No custom orders / custom colors (everything black, standard catalog)
- No subscription / recurring orders
- No marketplace (no third-party sellers)
- No international shipping (US only)
- No manufacturing integration (outsourced, inventory managed via admin app)
- No live chat support (ticket-based only)
- No cloud sync of 3D model files
- No plugin / extension system

### Shipping
- US only for v1
- International shipping is a non-goal, not in scope

### Enterprise Infrastructure Decisions

#### Logging
- Library: Pino (Fastify's built-in logger)
- Format: structured JSON, 5 levels (DEBUG/INFO/WARN/ERROR/FATAL)
- Correlation IDs per request, propagated to downstream calls
- Configurable log level via env var (WARN in prod, DEBUG in dev)
- Log destination: stderr (structured JSON)

#### Error Handling
- Typed error hierarchy: AppError base → ValidationError (400), NotFoundError (404), ConflictError (409), AuthenticationError (401), AuthorizationError (403), ExternalServiceError (502), RateLimitError (429), InternalError (500)
- Error codes: machine-readable strings (e.g., ERR_ORDER_NOT_FOUND)
- User-facing flag per error type
- Fastify error handler catches at boundary, logs with correlation ID, returns sanitized response

#### Configuration
- Single config module (src/config.ts), three-layer precedence: defaults → config file → env vars
- Fail-fast validation at startup
- Secrets from env vars only (DATABASE_URL, STRIPE_SECRET_KEY, SUPERTOKENS_API_KEY, EASYPOST_API_KEY, etc.)
- .env.example committed, .env gitignored
- All backing services swappable via config (Postgres, Stripe, SuperTokens, EasyPost, email provider)

#### Auth (SuperTokens)
- Customer auth: email/password via SuperTokens
- GitHub OAuth: "Link GitHub Account" for contributors (royalty tracking)
- Admin auth: separate SuperTokens setup with capability-based permissions
- Session refresh, token expiration configured via SuperTokens

#### CORS
- Restrictive: specific allowed origins (Astro site domain, Flutter app domains)
- Not wildcard

#### Rate Limiting
- Per-IP on public endpoints (guest checkout, catalog API)
- Per-user on authenticated endpoints
- Sliding window, standard headers (X-RateLimit-Limit, Remaining, Reset)
- 429 response with Retry-After header
- Timeout budgets on all external calls (Stripe, EasyPost, SuperTokens)

#### Observability
- Pino structured logging as the base layer
- Correlation IDs for request tracing
- [DEFERRED] Prometheus/OpenTelemetry metrics — add when traffic warrants it
- [DEFERRED] Distributed tracing — add when multi-service architecture materializes

#### Graceful Shutdown
- 30s timeout
- Ordered: stop accepting → drain in-flight → close WebSocket connections → close DB pool → close external connections → flush logs → exit

#### Health Checks
- GET /health (liveness): 200 if process alive, JSON body with uptime, version, dependency status
- GET /ready (readiness): 200 when ready to serve, 503 during startup/shutdown/dependency failure
- Active dependency checks: Postgres ping, SuperTokens reachability
- [DEFERRED] Stripe/EasyPost health checks — cached/background since they're external

#### Security Scanning
- Tier 1 (free): Trivy (SCA), Semgrep (SAST), Gitleaks (secrets pre-commit), npm audit
- Tier 1.5 (free for open source): Snyk, SonarCloud, OpenSSF Scorecard
- SARIF uploads to GitHub Security tab in CI
- TypeScript strict mode
- Security headers on all responses (HSTS, CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- Input validation via JSON schema at API boundary

#### CI/CD
- GitHub Actions (existing)
- Quality gates: tests pass, type check clean, lint clean, no critical vulns, no secrets
- Feature branches with PRs to main
- Squash-merge to main

#### Branching
- Feature branches with PRs
- Squash-merge to main
- Branch naming: feature/<name>, fix/<name>

#### DX Tooling
- Nix flakes: hierarchical (root, site/, scad/, api/, admin/, customer/, deploy/)
- direnv with `use flake` for auto-activation
- Script inventory: dev, test, test:unit, test:integration, lint, lint:fix, typecheck, build, db:migrate, db:seed, db:reset, codegen, clean, clean:all, check
- VS Code launch.json for debugging
- .env.example → .env pattern
- One-command dev: `nix develop` then `npm run dev`
- process-compose for backing services (Postgres, SuperTokens) in dev

#### Database Migrations
- Liquibase (user's explicit choice)
- SQL-first migrations with rollback support
- Seed script for dev bootstrapping and test fixtures

### Operations Runbook (required deliverable)
- Runbook document describing all maintenance tasks and their cadence
- Day-1 setup: new developer onboarding (clone → direnv → npm run dev)
- Day-2 ops: routine maintenance tasks with cadence
  - Database: backups (daily), vacuum/analyze (weekly), migration deployment (per release)
  - Liquibase: changelog review, rollback procedures, schema drift detection
  - Dependencies: Nix flake update (weekly/biweekly), npm audit (weekly), security scan review
  - Certificates: Let's Encrypt renewal monitoring (auto-renew, alert if <14 days)
  - Inventory: expired reservation cleanup (automated via cron), low stock alert review (daily)
  - Stripe: webhook endpoint health check, failed payment retry review
  - SuperTokens: session cleanup, token rotation schedule
  - EasyPost: tracking sync health, label purchase failure review
  - Infrastructure: OpenTofu plan review (before apply), Cloudflare DNS audit
  - Backups: test restore procedure (monthly)
  - Logs: log rotation, retention policy, storage cleanup
  - Security: dependency update review, CVE triage, Gitleaks scan review
- Failure recovery: what to do when each component fails (Postgres down, Stripe webhook failures, SuperTokens unreachable, EasyPost API errors)
- Escalation procedures: who to contact, what to check first, how to restart services

### Rejected Alternatives
- Knex/Prisma for migrations → user chose Liquibase (Java-ecosystem migration tool, SQL-first, supports rollback)
- Terraform → user chose OpenTofu (open-source fork, same HCL syntax, no license concerns)
- Stamps.com → USPS-only, old API, no modern SDK
- ShipStation → UI-focused fulfillment tool, not API-first
- Shippo/ShipEngine → viable but EasyPost has best API polish and carrier breadth
