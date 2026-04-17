# Kanix Constitution

## Core Principles

### I. Nix-First Infrastructure

All environment management, dependency pinning, and service composition uses Nix flakes. The repo uses a hierarchical flake system where each concern (OpenSCAD models, Astro site, backend API, admin app) has its own `flake.nix` that can be consumed independently or composed by a root flake. No global installs, no `curl | sh`, no unpinned dependencies. `direnv` with `use flake` is the default developer entry point.

### II. Separation of Concerns

The monorepo is organized by domain boundary, not by technology layer. Each domain (3D models, public site, backend API, admin app) lives in its own directory with its own flake, build scripts, and tests. Cross-cutting concerns (shared types, database schema, deployment) live in dedicated shared packages. No circular dependencies between domains.

### III. Test-First, Nix-Native Testing

Tests are first-class citizens at every level. NixOS VM tests validate server configuration, firewall rules, and service binding. Integration tests hit real servers and databases — no mocks for system boundaries. Every listening port, every firewall rule, every service binding, every secret permission gets a test. Negative tests are mandatory: for every "X works" assertion, there must be a corresponding "X fails from unauthorized context" assertion.

### IV. Specification-Driven Development

Natural-language specifications are the primary artifact. Every feature starts as a detailed spec describing what and why, then generates plans, tasks, and implementation. The architecture spec document is the system of record for domain model, state machines, API contracts, and route maps. Changes to the system start with spec amendments, not code changes.

### V. State Machine Correctness

Order, payment, fulfillment, shipping, inventory reservation, support ticket, and dispute lifecycles are governed by explicit state machines with orthogonal status dimensions. State transitions are validated at the domain layer. Invalid transitions are rejected, not silently ignored. All state changes are audited with actor attribution.

### VI. Evidence-First Design

Every shipping event, support interaction, payment record, and policy acknowledgment is preserved as an evidence record from day one. Evidence generation for chargeback defense is automatic, not manual scavenging. Order data uses snapshots (product, price, address, policy) — never relies on mutable current data for historical records.

### VII. Inventory Atomicity

Stock reservation and availability checks are atomic operations. `inventory_movement` is an immutable ledger. `inventory_balance` is derived current state. Shipments must not exceed paid and reserved quantities. The reservation lifecycle (create → TTL → consume or release) is enforced at the database level with constraints, not application-level hope.

### VIII. Admin Safety and Auditability

All privileged writes are audited with actor attribution, before/after snapshots, and IP address. Refunds, stock adjustments, policy changes, and role modifications require explicit actor identity. Capability-based permissions (not just role checks) gate every admin action. Roles are named bundles of capabilities.

### IX. Simplicity and Incremental Delivery

Start with the simplest implementation that satisfies the spec. No speculative abstractions, no premature optimization, no features beyond what's specified. The implementation follows a phased approach: Core Commerce Ops first, then Operational Workflows, then Dispute Readiness. Each phase delivers working, tested, deployed functionality.

## Technology Stack

- **Backend**: Fastify + TypeScript, Postgres, Stripe, SuperTokens
- **Admin App**: Flutter (web, iOS, Android)
- **Public Site**: Astro (existing, in `site/`)
- **3D Models**: OpenSCAD + BOSL2 (existing, in `scad/`)
- **Infrastructure**: Nix flakes (hierarchical), NixOS for server config
- **CI/CD**: GitHub Actions
- **Testing**: NixOS VM tests for infrastructure, Vitest/Jest for backend, Flutter test for admin app, real integration tests against Postgres/Stripe

## Security Posture

- Secure by default at every layer
- SuperTokens for customer and admin authentication
- Capability-based admin authorization
- All secrets managed through Nix (no plaintext in repo)
- Security scanning in CI (dependency audit, secret detection)
- HTTPS everywhere, restrictive CORS, security headers on all responses
- Input validation at system boundaries using JSON schema

## Governance

This constitution supersedes all other development practices for the Kanix project. Amendments require:
1. A written proposal describing the change and rationale
2. Update to this document with version bump
3. Migration plan for any existing code that conflicts

All code reviews must verify compliance with these principles. Complexity must be justified against Principle IX.

**Version**: 1.0.0 | **Ratified**: 2026-04-16 | **Last Amended**: 2026-04-16
